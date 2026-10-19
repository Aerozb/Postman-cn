param(
  [string]$PostmanDir,
  [switch]$CheckOnly,
  [switch]$Install,
  [switch]$CleanOldVersions,
  [switch]$KeepUpdates,
  [switch]$Details
)

$ErrorActionPreference = 'Stop'
$scriptsRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptsRoot
. (Join-Path $scriptsRoot 'lib/查找Postman.ps1')
. (Join-Path $scriptsRoot 'lib/官方下载.ps1')

if ($CheckOnly -and $Install) { throw '只检查与安装汉化选项互斥。' }
if (($CleanOldVersions -or $KeepUpdates) -and -not $Install) { throw '清理旧版及更新守卫参数须与 -Install 一起使用。' }
if ($PostmanDir) { $app = Resolve-PostmanAppDirFromPath $PostmanDir }
else { $app = Find-InstalledPostmanAppDir -RepoRoot $repoRoot -IncludeRemembered }
if (-not $app) { throw '请先安装 Windows x64 Postman，或用 -PostmanDir 指定已有安装目录。' }
$root = Get-PostmanInstallRoot $app
foreach ($name in @('Postman.exe', 'Update.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { throw '下载功能需要包含 Postman.exe、Update.exe 和 app-* 的安装根目录。' }
}
$stream = [IO.File]::OpenRead((Join-Path $app 'resources/app.asar'))
try { $package = Read-PostmanAsarPackage $stream } finally { $stream.Dispose() }
Assert-OfficialVersion $package.version
if ($package.name -cne 'Postman' -or (Split-Path -Leaf $app) -cne "app-$($package.version)") { throw '本机版本目录与 app.asar 元数据不一致。' }
Write-Host '[Postman 汉化] 正在查询官方最新稳定版本。'
$latest = Get-OfficialLatest -CurrentVersion $package.version
Write-Host "[Postman 汉化] 本机 $($latest.Current)，官方最新 $($latest.Latest)。"
if ($Details) { Write-Host ('版本查询链：' + ($latest.Chain -join ' → ') + ' → HTTP 204 / 空正文') }
if (-not $CheckOnly) {
  $feedBase = Get-OfficialFeedBase $latest
  $response = Get-OfficialResponse "https://dl.pstmn.io/update/win64/$feedBase/stable"
  $feed = ConvertFrom-OfficialFeed -Body $response.Body -ExpectedVersion $latest.Latest
  $result = Save-OfficialPackage -Root $root -Feed $feed
  Write-Host "[Postman 汉化] 官方完整包、签名和版本校验通过：$($result.Version)。"
  if ($Details) { Write-Host "官方包：$($result.Archive)"; Write-Host "版本目录：$($result.AppDir)" }
  if ($Install) {
    # 复用现有安装器，验证失败时由安装器回滚；只有成功后才按需清理旧版。
    & (Join-Path $PSScriptRoot '安装汉化.ps1') -PostmanDir $result.AppDir -Latest -Verify -DisableUpdates:(-not $KeepUpdates) -CleanOldVersions:$CleanOldVersions
  } else {
    Write-Host '[Postman 汉化] 下载准备完成；现有汉化、进程和用户数据保持原样。运行 download -Install 可继续安装汉化。'
  }
}
$global:LASTEXITCODE = 0
