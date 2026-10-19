param([switch]$Details)

# 官方 HTTP、进程与正式文件路径使用桩；ZIP 与原子写入仅在独立临时目录回归。
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../lib/官方下载.ps1')
$script:DownloadChecks = 0
function Assert-DownloadTest([bool]$Condition, [string]$Name) {
  if (-not $Condition) { throw "官方下载回归失败：$Name" }
  $script:DownloadChecks++
  if ($Details) { Write-Host "[通过] $Name" }
}
function Assert-DownloadThrows([scriptblock]$Action, [string]$Pattern, [string]$TestLabel) {
  $message = ''
  try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
  Assert-DownloadTest ($message -match $Pattern) $TestLabel
}

& {
  $script:Reads = New-Object 'System.Collections.Generic.List[string]'
  $script:Waits = New-Object 'System.Collections.Generic.List[int]'
  function Invoke-OfficialHttp {
    param($Url, $OutFile)
    if ($OutFile -or -not $script:Responses.Count) { throw '非预期的网络调用' }
    $script:Reads.Add($Url)
    return $script:Responses.Dequeue()
  }
  function Start-Sleep { param($Milliseconds); $script:Waits.Add($Milliseconds) }
  function Set-DownloadResponses([object[]]$Responses) {
    $script:Reads.Clear(); $script:Waits.Clear()
    $script:Responses = New-Object 'System.Collections.Generic.Queue[object]'
    foreach ($item in $Responses) { $script:Responses.Enqueue([pscustomobject]$item) }
  }
  Set-DownloadResponses @(@{Code=0;Status=200;Body='{"version":"12.32.1"}'}, @{Code=0;Status=200;Body='{"version":"12.32.4"}'}, @{Code=0;Status=204;Body=''})
  $latest = Get-OfficialLatest '12.31.3'
  Assert-DownloadTest ($latest.Latest -ceq '12.32.4' -and ($latest.Chain -join ',') -ceq '12.31.3,12.32.1,12.32.4') '查询直到 204，保留完整递增链'
  Assert-DownloadTest ($script:Reads.Count -eq 3 -and $script:Reads[2] -match 'currentVersion=12.32.4&') '使用上一步返回版本继续查询'
  Assert-DownloadTest ((Get-OfficialFeedBase $latest) -ceq '12.32.1') '完整包 feed 使用最终版本的前一步'
  Set-DownloadResponses @(@{Code=0;Status=204;Body=''})
  $latest = Get-OfficialLatest '12.32.4'
  Assert-DownloadTest ($latest.Chain.Count -eq 1 -and (Get-OfficialFeedBase $latest) -ceq '12.32.3') '已是最新版也能选取较低比较版本获取完整包'
  Assert-DownloadTest ((Get-OfficialFeedBase ([pscustomobject]@{Latest='12.32.0';Chain=@('12.32.0')})) -ceq '12.31.0') '零补丁版本的 feed 比较值仍严格较低'
  Set-DownloadResponses @(@{Code=0;Status=200;Body=' '})
  Assert-DownloadTest ((Get-OfficialLatest '12.32.4').Latest -ceq '12.32.4') '空正文作为无后继版本'
  foreach ($body in @('{', '{}', '[]', '{"version":"13.0.0"}', '{"version":"12.32.4-beta"}', '{"version":"12.32.4"}', '{"version":"12.31.0"}')) {
    Set-DownloadResponses @(@{Code=0;Status=200;Body=$body})
    Assert-DownloadThrows { Get-OfficialLatest '12.32.4' } 'JSON|版本|支持范围' "异常状态响应停止：$body"
    Assert-DownloadTest ($script:Reads.Count -eq 1) '异常或非递增版本不继续请求'
  }
  Set-DownloadResponses @(@{Code=0;Status=200;Body='{"version":"12.32.5"}'})
  Assert-DownloadThrows { Get-OfficialLatest '12.32.4' -MaxChecks 1 } '上限' '版本链达到上限不声称最新版'
  Set-DownloadResponses @(@{Code=7;Status=0;Body=''}, @{Code=0;Status=503;Body=''}, @{Code=0;Status=204;Body=''})
  Assert-DownloadTest ((Get-OfficialLatest '12.32.4').Latest -eq '12.32.4' -and $script:Reads.Count -eq 3) '网络及 5xx 查询最多三次'
  Assert-DownloadTest (($script:Waits -join ',') -eq '500,1000') '查询重试有界退避'
  foreach ($status in @(401,403,404,429)) {
    Set-DownloadResponses @(@{Code=0;Status=$status;Body=''})
    Assert-DownloadThrows { Get-OfficialLatest '12.32.4' } '查询失败' "HTTP $status 不当成无更新"
    Assert-DownloadTest ($script:Reads.Count -eq 1 -and $script:Waits.Count -eq 0) '明确 HTTP 错误不自动重试'
  }
}

$sha = 'F7C8F78E3C0CAC3564956A2009B49EFACFE21C01'
$url = 'https://dl.pstmn.io/download/12.32.4/Postman-x64-12.32.4-full.nupkg'
$line = "$sha $url 1234"
foreach ($body in @($line, ('"' + $line + '"'))) {
  $feed = ConvertFrom-OfficialFeed $body '12.32.4'
  Assert-DownloadTest ($feed.Version -eq '12.32.4' -and $feed.Size -eq 1234 -and $feed.Url -ceq $url -and $feed.Sha1 -ceq $sha) '解析裸文本和 JSON 字符串 feed'
}
foreach ($body in @('', '[]', '{"url":"x"}', "$line`n$line", $line.Replace('-full', '-delta'), $line.Replace('x64', 'arm64'), $line.Replace('12.32.4-full', '12.32.3-full'), $line.Replace('https:', 'http:'), $line.Replace('dl.pstmn.io/', 'dl.pstmn.io.example.invalid/'), $line.Replace('1234', '1073741825'), $line.Replace($sha, 'bad'))) {
  Assert-DownloadThrows { ConvertFrom-OfficialFeed $body '12.32.4' } '清单|资源地址|大小' '错误版本、格式、平台或地址的包清单不使用'
}
foreach ($badUrl in @('https://dl.pstmn.io:8443/x', 'https://u:p@dl.pstmn.io/x', 'https://dl.pstmn.io/x#fragment', 'file:///C:/file', 'https://example.invalid/x')) {
  Assert-DownloadThrows { Assert-OfficialUrl $badUrl } '地址' '官方资源 URL 严格校验'
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('postman-zh-download-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
  $inside = Join-Path $testRoot 'packages/stage/file.txt'
  Assert-DownloadTest ((Assert-DownloadPath $testRoot $inside) -eq [IO.Path]::GetFullPath($inside)) '允许指定安装根目录内的路径'
  Assert-DownloadThrows { Assert-DownloadPath $testRoot $testRoot } '超出' '根目录本身不作临时删除目标'
  Assert-DownloadThrows { Assert-DownloadPath $testRoot ($testRoot + '-other/file') } '超出' '相同前缀的相邻目录不视为子目录'
  Assert-DownloadThrows { Assert-DownloadPath $testRoot (Join-Path $testRoot '../outside') } '超出' '上级路径不进入文件操作'
  foreach ($name in @('../outside', '/absolute', 'C:/outside', 'lib/../outside', 'file:stream', 'AUX.txt', 'folder./file', 'a//b', 'a/./b', 'a?/b')) {
    Assert-DownloadThrows { Get-DownloadEntryPath $testRoot $name } '路径' "ZIP 危险路径被拒绝：$name"
  }
  Assert-DownloadTest ((Get-DownloadEntryPath $testRoot 'lib/net45/resources/file.json') -eq (Join-Path $testRoot 'lib/net45/resources/file.json')) 'ZIP 正常路径可解析'

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  function New-DownloadZip {
    param([string]$File, [string]$ExtraEntry = '', [string]$Version = '12.32.4')
    $zip = [IO.Compression.ZipFile]::Open($File, [IO.Compression.ZipArchiveMode]::Create)
    try {
      $data = [ordered]@{
        'Postman.nuspec' = "<package><metadata><id>Postman</id><version>$Version</version><title>Postman x64 $Version</title></metadata></package>"
        'lib/net45/Postman.exe' = 'fixture executable'
        'lib/net45/resources/app.asar' = 'fixture asar'
      }
      foreach ($key in $data.Keys) {
        $entry = $zip.CreateEntry($key); $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write($data[$key]) } finally { $writer.Dispose() }
      }
      if ($ExtraEntry) {
        $entry = $zip.CreateEntry($ExtraEntry); $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write('unexpected') } finally { $writer.Dispose() }
      }
    } finally { $zip.Dispose() }
  }
  $archive = Join-Path $testRoot 'fixture.nupkg'; New-DownloadZip $archive
  $fixtureFeed = [pscustomobject]@{ Version='12.32.4';Name='Postman-x64-12.32.4-full.nupkg';Url=$url;Size=(Get-Item -LiteralPath $archive).Length;Sha1=(Get-FileHash -LiteralPath $archive -Algorithm SHA1).Hash }
  Assert-OfficialArchive $archive $fixtureFeed
  Assert-DownloadTest $true '真实 ZIP 大小、SHA1 与 PK 头校验'
  $fixtureFeed.Size++
  Assert-DownloadThrows { Assert-OfficialArchive $archive $fixtureFeed } '校验失败' '包大小错误即停止'
  $fixtureFeed.Size--
  $goodSha=$fixtureFeed.Sha1; $fixtureFeed.Sha1='0' * 40
  Assert-DownloadThrows { Assert-OfficialArchive $archive $fixtureFeed } '校验失败' 'SHA1 错误即停止'
  $fixtureFeed.Sha1=$goodSha
  $destination=Join-Path $testRoot 'extracted'
  Expand-OfficialArchive $archive $destination '12.32.4'
  Assert-DownloadTest ((Test-Path -LiteralPath (Join-Path $destination 'Postman.exe')) -and (Test-Path -LiteralPath (Join-Path $destination 'resources/app.asar'))) '只将 lib/net45 解包为 app 结构'
  Assert-DownloadTest (-not (Test-Path -LiteralPath (Join-Path $destination 'Postman.nuspec'))) 'nuspec 元数据不混入 app 目录'
  Assert-DownloadThrows { Expand-OfficialArchive $archive (Join-Path $testRoot 'wrong-version') '12.32.5' } 'nuspec' 'nuspec 版本不一致在提取前停止'
  foreach ($bad in @('../outside.txt', 'lib/net45/a/../../outside.txt', 'lib/net45/POSTMAN.exe')) {
    $zipPath=Join-Path $testRoot ([guid]::NewGuid().ToString('N')+'.zip');New-DownloadZip $zipPath $bad
    Assert-DownloadThrows { Expand-OfficialArchive $zipPath (Join-Path $testRoot 'bad-extraction') '12.32.4' } '路径' "遍历与 Windows 大小写重复路径在解包前拒绝：$bad"
  }

  $packages=Join-Path $testRoot 'packages';[IO.Directory]::CreateDirectory($packages)|Out-Null
  $manifest=Join-Path $packages 'RELEASES';$oldLine='ABC old.nupkg 10'
  [IO.File]::WriteAllText($manifest,$oldLine+"`r`n",[Text.UTF8Encoding]::new($false))
  Update-OfficialReleases $testRoot $fixtureFeed
  $first=[IO.File]::ReadAllText($manifest);Update-OfficialReleases $testRoot $fixtureFeed
  Assert-DownloadTest ($first -ceq [IO.File]::ReadAllText($manifest) -and $first.Contains($oldLine)) 'RELEASES 原子合并且重复运行幂等，保留其他版本'
  Assert-DownloadTest ([IO.File]::ReadAllBytes($manifest)[0] -ne 0xEF) 'RELEASES 无 UTF-8 BOM'

  & {
    function Read-PostmanAsarPackage { param($Stream); return @{name='Postman';version='12.32.4'} }
    $official=Join-Path $testRoot 'official-files';$installed=Join-Path $testRoot 'existing/app-12.32.4'
    [IO.Directory]::CreateDirectory((Join-Path $official 'resources'))|Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $installed 'resources'))|Out-Null
    foreach($name in @('Postman.exe','Postman_ExecutionStub.exe','resources/app.asar','resources/native.node')) {
      [IO.File]::WriteAllText((Join-Path $official $name),'official '+$name)
      if($name -eq 'Postman_ExecutionStub.exe') { $target=Join-Path (Split-Path -Parent $installed) 'Postman.exe' }
      elseif($name -eq 'resources/app.asar') { $target=Join-Path $installed 'resources/app.asar.original' }
      else { $target=Join-Path $installed $name }
      [IO.File]::Copy((Join-Path $official $name),$target)
    }
    [IO.File]::WriteAllText((Join-Path $installed 'resources/app.asar'),'localized')
    Assert-ExistingOfficialApp $installed $official '12.32.4'
    Assert-DownloadTest $true '已有汉化读取英文备份，兼容 Squirrel 将启动器移到根目录'
    [IO.File]::WriteAllText((Join-Path $installed 'resources/native.node'),'wrong native module')
    Assert-DownloadThrows {Assert-ExistingOfficialApp $installed $official '12.32.4'} '不一致' '已有版本内原生模块不匹配也停止，避免混版本'
  }

  # 执行真实事务，替换下载与程序签名边界；不接触真实安装或应用进程。
  & {
    $script:Downloads=0;$script:ExistingChecks=0;$script:FailDownload=$false;$script:FailApp=$false
    $script:FixtureDownloadArchive=$archive
    function Write-Host { param($Object) }
    function Invoke-OfficialHttp {
      param($Url,$OutFile)
      $script:Downloads++
      if($script:FailDownload){[IO.File]::WriteAllText($OutFile,'partial');return @{Code=28;Status=200}}
      [IO.File]::Copy($script:FixtureDownloadArchive,$OutFile)
      return @{Code=0;Status=200}
    }
    function Assert-OfficialApp {param($Directory,$Version);if($script:FailApp){throw 'fixture signature failure'}}
    function Assert-ExistingOfficialApp {param($Existing,$Official,$Version);$script:ExistingChecks++}
    $root=Join-Path $testRoot 'transaction';[IO.Directory]::CreateDirectory($root)|Out-Null
    $result=Save-OfficialPackage $root $fixtureFeed
    Assert-DownloadTest ($script:Downloads -eq 1 -and -not $result.ReusedApp -and (Test-Path -LiteralPath (Join-Path $result.AppDir 'Postman.exe'))) '下载完成且验证后才切入新版本目录'
    $marker=Join-Path $result.AppDir 'resources/app.asar';[IO.File]::WriteAllText($marker,'existing localized payload')
    $again=Save-OfficialPackage $root $fixtureFeed
    Assert-DownloadTest ($again.ReusedApp -and $script:Downloads -eq 1 -and $script:ExistingChecks -eq 1 -and [IO.File]::ReadAllText($marker) -eq 'existing localized payload') '同版本复用下载与已有汉化，不覆盖目录'
    Assert-DownloadTest (@(Get-ChildItem -LiteralPath (Join-Path $root 'packages') -Filter 'postman-zh-stage-*').Count -eq 0) '事务结束清理自己的 staging'
    $lock=[IO.File]::Open((Join-Path $root 'packages/.postman-zh-download.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { Assert-DownloadThrows {Save-OfficialPackage $root $fixtureFeed} '已有下载' '相同安装目录的并发下载互斥' } finally {$lock.Dispose()}
    $failedRoot=Join-Path $testRoot 'failed-network';[IO.Directory]::CreateDirectory($failedRoot)|Out-Null;$script:FailDownload=$true
    Assert-DownloadThrows {Save-OfficialPackage $failedRoot $fixtureFeed} '下载失败' '下载中断失败，不调用安装'
    Assert-DownloadTest (@(Get-ChildItem -LiteralPath (Join-Path $failedRoot 'packages') -Filter '*.part-*').Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $failedRoot 'app-12.32.4'))) '下载失败清理半包且未创建正式版本'
    $signatureRoot=Join-Path $testRoot 'failed-signature';[IO.Directory]::CreateDirectory($signatureRoot)|Out-Null;$script:FailDownload=$false;$script:FailApp=$true
    Assert-DownloadThrows {Save-OfficialPackage $signatureRoot $fixtureFeed} 'signature' '程序签名检查失败不切入正式版本'
    Assert-DownloadTest (-not (Test-Path -LiteralPath (Join-Path $signatureRoot 'app-12.32.4')) -and -not (Test-Path -LiteralPath (Join-Path $signatureRoot 'packages/RELEASES'))) '签名失败不写 RELEASES 或替换已有版本'
  }
} finally {
  # 先验证绝对目标仍位于本次唯一临时目录，再由同一 PowerShell 清理。
  $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  Remove-DownloadArtifact -Root $parent -Path $testRoot
}
Write-Host "[通过] 官方下载回归：$script:DownloadChecks 项。"
$global:LASTEXITCODE=0
