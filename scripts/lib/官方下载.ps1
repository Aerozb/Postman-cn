# Windows x64 官方升级包：有界查询、校验后解包、同版本保留现有汉化。
# 仅函数定义；网络及文件边界可供离线回归替换。
. (Join-Path $PSScriptRoot 'ASAR元数据.ps1')

function Assert-OfficialVersion {
  param([string]$Version)
  if ($Version -cnotmatch '^12\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') {
    throw '官方版本格式异常，或已超出当前 Windows x64 12.x 支持范围。'
  }
  try { [void][version]$Version } catch { throw '官方版本号超出有效范围。' }
}

function Assert-OfficialUrl {
  param([string]$Url)
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -cne 'https' -or $uri.Host -cne 'dl.pstmn.io' -or
      -not $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Fragment) {
    throw '官方资源地址校验失败。'
  }
}

function Invoke-OfficialHttp {
  param([string]$Url, [string]$OutFile)
  Assert-OfficialUrl $Url
  $curl = Get-Command curl.exe -ErrorAction Stop
  $arguments = @('--silent', '--show-error', '--location', '--max-redirs', '5',
    '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15',
    '--max-time', $(if ($OutFile) { '900' } else { '45' }),
    '--max-filesize', $(if ($OutFile) { '1073741824' } else { '2097152' }),
    '--write-out', "`nPOSTMAN_HTTP:%{http_code}")
  if ($OutFile) { $arguments += @('--output', $OutFile) }
  # curl 自行遵循显式代理变量；未配置时沿用已启用的 Windows 静态 HTTPS 代理。
  if (-not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY -and -not $env:ALL_PROXY) {
    try {
      $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
      if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
        $server = [string]$settings.ProxyServer
        if ($server.Contains('=')) {
          $server = @($server -split ';' | Where-Object { $_ -match '^\s*https\s*=' } | Select-Object -First 1) -replace '^\s*https\s*=\s*', ''
          $server = [string]($server | Select-Object -First 1)
        }
        if ($server) {
          if ($server -notmatch '^\w+://') { $server = 'http://' + $server }
          $proxy = $null
          if ([Uri]::TryCreate($server, [UriKind]::Absolute, [ref]$proxy) -and
              $proxy.Scheme -in @('http', 'https') -and $proxy.Host -and
              -not $proxy.Query -and -not $proxy.Fragment -and $proxy.AbsolutePath -eq '/') {
            $arguments += @('--proxy', $proxy.AbsoluteUri)
            if (-not $env:NO_PROXY -and $settings.ProxyOverride) {
              $bypass = ([string]$settings.ProxyOverride).Replace('<local>', 'localhost;127.0.0.1;::1').Replace(';', ',')
              $arguments += @('--noproxy', $bypass)
            }
          }
        }
      }
    } catch { }
  }
  $arguments += $Url
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = (& $curl.Source @arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $oldPreference }
  $status = 0; $body = ''
  if ($output -match '(?s)\A(.*)\r?\nPOSTMAN_HTTP:([0-9]{3})\s*\z') {
    $body = $Matches[1].Trim(); $status = [int]$Matches[2]
  }
  return [pscustomobject]@{ Code = $code; Status = $status; Body = $body }
}

function Get-OfficialResponse {
  param([string]$Url)
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $response = Invoke-OfficialHttp -Url $Url
    if ($response.Code -eq 0 -and $response.Status -in @(200, 204)) { return $response }
    if (($response.Code -ne 0 -or $response.Status -ge 500) -and $attempt -lt 3) {
      Start-Sleep -Milliseconds (500 * $attempt)
      continue
    }
    throw "官方接口查询失败（HTTP $($response.Status)，网络退出码 $($response.Code)）。"
  }
}

function Get-OfficialLatest {
  param([string]$CurrentVersion, [ValidateRange(1, 30)][int]$MaxChecks = 20)
  Assert-OfficialVersion $CurrentVersion
  $chain = @($CurrentVersion)
  for ($i = 0; $i -lt $MaxChecks; $i++) {
    $current = $chain[-1]
    $response = Get-OfficialResponse "https://dl.pstmn.io/update/status?currentVersion=$current&arch=64&platform=win"
    if ($response.Status -eq 204 -or [string]::IsNullOrWhiteSpace($response.Body)) {
      return [pscustomobject]@{ Current = $CurrentVersion; Latest = $current; Chain = $chain }
    }
    try { $data = $response.Body | ConvertFrom-Json -ErrorAction Stop } catch { throw '官方状态响应不是有效 JSON。' }
    if ($data -is [array] -or $data.version -isnot [string]) { throw '官方状态响应缺少明确版本。' }
    Assert-OfficialVersion $data.version
    if ([version]$data.version -le [version]$current) { throw '官方版本链没有递增，已停止查询。' }
    $chain += $data.version
  }
  throw '官方版本查询达到上限，尚未确认最终版本。'
}

function Get-OfficialFeedBase {
  param([object]$Latest)
  if ($Latest.Chain.Count -gt 1) { return $Latest.Chain[-2] }
  # 已是最新版时，feed(当前版本) 会返回 204；用严格较低的比较版本请求当前完整包。
  $v = [version]$Latest.Latest
  if ($v.Build -gt 0) { return "12.$($v.Minor).$($v.Build - 1)" }
  if ($v.Minor -gt 0) { return "12.$($v.Minor - 1).0" }
  throw '当前版本没有可用的较低比较版本。'
}

function ConvertFrom-OfficialFeed {
  param([string]$Body, [string]$ExpectedVersion)
  Assert-OfficialVersion $ExpectedVersion
  $bodyText = $Body.Trim()
  if ($bodyText.StartsWith('"')) {
    try { $bodyText = $bodyText | ConvertFrom-Json -ErrorAction Stop } catch { throw '官方包清单 JSON 异常。' }
    if ($bodyText -isnot [string]) { throw '官方包清单应为字符串。' }
  }
  $found = @()
  foreach ($line in ($bodyText -split '\r?\n')) {
    if (-not $line.Trim()) { continue }
    if ($line -notmatch '^([A-Fa-f0-9]{40})\s+(https://\S+)\s+([1-9][0-9]*)\s*\z') { throw '官方包清单行格式异常。' }
    $sha = $Matches[1].ToUpperInvariant(); $url = $Matches[2]
    try { $size = [long]$Matches[3] } catch { throw '官方包大小异常。' }
    Assert-OfficialUrl $url
    $name = [Uri]::UnescapeDataString(([Uri]$url).Segments[-1])
    if ($name -cmatch '^Postman-x64-(12\.\d+\.\d+)-full\.nupkg\z' -and $Matches[1] -ceq $ExpectedVersion) {
      if ($size -gt 1GB) { throw '官方包大小超出下载上限。' }
      $found += [pscustomobject]@{ Version = $ExpectedVersion; Name = $name; Url = $url; Size = $size; Sha1 = $sha }
    }
  }
  if ($found.Count -ne 1) { throw '官方清单未返回唯一的目标版本 Windows x64 完整 nupkg。' }
  return $found[0]
}

function Assert-DownloadPath {
  param([string]$Root, [string]$Path)
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '下载文件路径超出指定安装根目录。' }
  # 检查全部现存祖先，拒绝 junction / symlink 绕出目录。
  $probe = $full
  while ($probe) {
    if (Test-Path -LiteralPath $probe) {
      if ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '下载路径含重解析点。' }
    }
    $parent = Split-Path -Parent $probe
    if ($parent -eq $probe) { break }
    $probe = $parent
  }
  return $full
}

function Remove-DownloadArtifact {
  param([string]$Root, [string]$Path)
  $full = Assert-DownloadPath -Root $Root -Path $Path
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

function Assert-OfficialArchive {
  param([string]$Path, [object]$Feed)
  if ((Get-Item -LiteralPath $Path).Length -ne $Feed.Size -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash -cne $Feed.Sha1) { throw '官方 nupkg 大小或 SHA1 校验失败。' }
  $stream = [IO.File]::OpenRead($Path)
  try { if ($stream.ReadByte() -ne 0x50 -or $stream.ReadByte() -ne 0x4B) { throw '官方 nupkg 文件头不是 ZIP。' } } finally { $stream.Dispose() }
}

function Get-DownloadEntryPath {
  param([string]$Destination, [string]$EntryName)
  $relative = $EntryName.Replace('/', '\')
  if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw '压缩包包含绝对路径。' }
  foreach ($part in ($relative.TrimEnd('\') -split '\\')) {
    if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$|[<>"|?*\x00-\x1f]' -or
        $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw '压缩包包含不规范路径。' }
  }
  $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
  $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '压缩包路径越界。' }
  return $full
}

function Expand-OfficialArchive {
  param([string]$Archive, [string]$Destination, [string]$Version)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    if ($zip.Entries.Count -gt 50000) { throw '官方包文件数超出上限。' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $entries = @(); $nuspec = @(); [long]$expanded = 0
    foreach ($entry in $zip.Entries) {
      [void](Get-DownloadEntryPath -Destination $Destination -EntryName $entry.FullName)
      if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or
          ($entry.ExternalAttributes -band 0x400)) { throw '官方包中存在链接条目。' }
      if (-not $seen.Add($entry.FullName.Replace('\', '/').TrimEnd('/'))) { throw '官方包中存在重复路径。' }
      $expanded += $entry.Length
      if ($entry.Length -gt 1GB -or $expanded -gt 4GB) { throw '官方包展开大小超出上限。' }
      if ($entry.FullName -cmatch '^[^/\\]+\.nuspec\z') { $nuspec += $entry }
      if ($entry.FullName -cmatch '^lib/net45/(.+)' -and -not $entry.FullName.EndsWith('/')) {
        $entries += [pscustomobject]@{ Entry = $entry; Path = (Get-DownloadEntryPath $Destination $Matches[1]) }
      }
    }
    if ($nuspec.Count -ne 1 -or $nuspec[0].Length -gt 1MB) { throw '官方包缺少唯一的 nuspec 元数据。' }
    $reader = [IO.StreamReader]::new($nuspec[0].Open())
    try { $xmlText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $xml = New-Object Xml.XmlDocument; $xml.XmlResolver = $null
    if ($xmlText -match '<!DOCTYPE|<!ENTITY') { throw '官方元数据包含异常实体。' }
    $xml.LoadXml($xmlText)
    if ($xml.package.metadata.id -cne 'Postman' -or $xml.package.metadata.version -cne $Version -or
        $xml.package.metadata.title -cne "Postman x64 $Version") { throw '官方包 nuspec 版本或平台不一致。' }
    if ($entries.Count -eq 0) { throw '官方包没有 lib/net45 文件。' }
    foreach ($item in $entries) {
      [IO.Directory]::CreateDirectory((Split-Path -Parent $item.Path)) | Out-Null
      $input = $item.Entry.Open(); $output = $null
      try { $output = [IO.File]::Open($item.Path, [IO.FileMode]::CreateNew); $input.CopyTo($output) }
      finally { if ($output) { $output.Dispose() }; $input.Dispose() }
    }
  } finally { $zip.Dispose() }
}

function Assert-OfficialApp {
  param([string]$Directory, [string]$Version)
  $exe = Join-Path $Directory 'Postman.exe'
  if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion -cne $Version) { throw 'Postman.exe 版本与官方清单不一致。' }
  $stream = [IO.File]::OpenRead($exe); $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Postman.exe 文件头异常。' }
    $stream.Position = 0x3C; $offset = $reader.ReadUInt32()
    if ($offset -gt $stream.Length - 6) { throw 'Postman.exe PE 偏移异常。' }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Postman.exe 不是 Windows x64 程序。' }
  } finally { $reader.Dispose(); $stream.Dispose() }
  $signature = Get-AuthenticodeSignature -LiteralPath $exe
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O="?Postman, Inc\."?(?:,|$)') { throw 'Postman.exe 官方数字签名验证失败。' }
  $stream = [IO.File]::OpenRead((Join-Path $Directory 'resources/app.asar'))
  try { $package = Read-PostmanAsarPackage $stream } finally { $stream.Dispose() }
  if ($package.name -cne 'Postman' -or $package.version -cne $Version) { throw 'app.asar 包内版本与官方清单不一致。' }
}

function Assert-ExistingOfficialApp {
  param([string]$Existing, [string]$Official, [string]$Version)
  $officialRoot = [IO.Path]::GetFullPath($Official).TrimEnd('\')
  foreach ($file in Get-ChildItem -LiteralPath $officialRoot -Recurse -File) {
    $name = $file.FullName.Substring($officialRoot.Length + 1)
    $current = Assert-DownloadPath $Existing (Join-Path $Existing $name)
    # Squirrel 安装后会把 ExecutionStub 放到安装根目录并改名为 Postman.exe。
    if ($name -ceq 'Postman_ExecutionStub.exe' -and -not (Test-Path -LiteralPath $current)) {
      $installRoot = Split-Path -Parent $Existing
      $current = Assert-DownloadPath $installRoot (Join-Path $installRoot 'Postman.exe')
    }
    if ($name -eq 'resources\app.asar' -and (Test-Path -LiteralPath ($current + '.original'))) {
      $current = Assert-DownloadPath $Existing ($current + '.original')
    }
    if (-not (Test-Path -LiteralPath $current) -or
        (Get-FileHash -LiteralPath $current -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "已存在版本目录与官方包不一致，已保留原目录：$name" }
  }
  $stream = [IO.File]::OpenRead((Join-Path $Existing 'resources/app.asar'))
  try { $package = Read-PostmanAsarPackage $stream } finally { $stream.Dispose() }
  if ($package.name -cne 'Postman' -or $package.version -cne $Version) { throw '已存在版本目录的 asar 版本不一致。' }
}

function Update-OfficialReleases {
  param([string]$Root, [object]$Feed)
  $manifest = Assert-DownloadPath $Root (Join-Path $Root 'packages/RELEASES')
  $lines = @()
  if (Test-Path -LiteralPath $manifest) { $lines = @([IO.File]::ReadAllLines($manifest)) }
  $name = [regex]::Escape($Feed.Name)
  $lines = @($lines | Where-Object { $_ -and $_ -notmatch "\s$name\s" })
  $text = (@($lines) + "$($Feed.Sha1) $($Feed.Name) $($Feed.Size)") -join "`r`n"
  $text += "`r`n"
  if ((Test-Path -LiteralPath $manifest) -and [IO.File]::ReadAllText($manifest) -ceq $text) { return }
  $temporary = Assert-DownloadPath $Root ($manifest + '.zh-' + [guid]::NewGuid().ToString('N'))
  $backup = Assert-DownloadPath $Root ($temporary + '.previous')
  try {
    [IO.File]::WriteAllText($temporary, $text, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $manifest) {
      [IO.File]::Replace($temporary, $manifest, $backup)
      Remove-DownloadArtifact $Root $backup
    }
    else { [IO.File]::Move($temporary, $manifest) }
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-DownloadArtifact $Root $temporary } }
}

function Save-OfficialPackage {
  param([string]$Root, [object]$Feed)
  $packages = Assert-DownloadPath $Root (Join-Path $Root 'packages')
  [IO.Directory]::CreateDirectory($packages) | Out-Null
  $id = [guid]::NewGuid().ToString('N')
  $archive = Assert-DownloadPath $Root (Join-Path $packages $Feed.Name)
  $part = Assert-DownloadPath $Root ($archive + ".part-$id")
  $stage = Assert-DownloadPath $Root (Join-Path $packages "postman-zh-stage-$id")
  $target = Assert-DownloadPath $Root (Join-Path $Root "app-$($Feed.Version)")
  $lockPath = Assert-DownloadPath $Root (Join-Path $packages '.postman-zh-download.lock')
  try { $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }
  catch { throw '已有下载操作正在使用此安装目录，请等待其结束。' }
  try {
    if (Test-Path -LiteralPath $archive) {
      Assert-OfficialArchive $archive $Feed
      Write-Host '[Postman 汉化] 已复用通过校验的官方完整包。'
    } else {
      Write-Host "[Postman 汉化] 正在下载官方 $($Feed.Version) 完整包（$([math]::Round($Feed.Size / 1MB, 1)) MB）。"
      $response = Invoke-OfficialHttp -Url $Feed.Url -OutFile $part
      if ($response.Code -ne 0 -or $response.Status -ne 200) { throw "官方包下载失败（HTTP $($response.Status)，网络退出码 $($response.Code)）。" }
      Assert-OfficialArchive $part $Feed
      [IO.File]::Move($part, $archive)
    }
    Expand-OfficialArchive -Archive $archive -Destination $stage -Version $Feed.Version
    Assert-OfficialApp -Directory $stage -Version $Feed.Version
    $existing = Test-Path -LiteralPath $target
    if ($existing) {
      Assert-ExistingOfficialApp -Existing $target -Official $stage -Version $Feed.Version
    } else {
      [void](Assert-DownloadPath $Root $target)
      [IO.Directory]::Move($stage, $target)
    }
    Update-OfficialReleases -Root $Root -Feed $Feed
    return [pscustomobject]@{ AppDir = $target; Version = $Feed.Version; ReusedApp = $existing; Archive = $archive }
  } finally {
    try {
      if (Test-Path -LiteralPath $part) { Remove-DownloadArtifact $Root $part }
      if (Test-Path -LiteralPath $stage) { Remove-DownloadArtifact $Root $stage }
    } finally { $lock.Dispose() }
  }
}
