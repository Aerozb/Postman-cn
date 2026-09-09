# 通过 postman-zh.bat publish -TestOnly 运行。只加载函数并使用内存响应，
# 不执行发布脚本主体，不接触凭据，也不发送真实网络请求。
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '发布中文版.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw '发布脚本语法检查失败。' }
$functionNames = @(
  'Get-GitHubFailureKind', 'Get-GitHubFailureMessage', 'Invoke-GitHubRead',
  'Read-GitHubJson', 'Get-PublishGitHubIdentity', 'Get-PublishGitHubRepository',
  'Get-PublishSystemProxy', 'Initialize-PublishNetwork'
)
foreach ($name in $functionNames) {
  $definition = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $false)
  if ($null -eq $definition) { throw "缺少待验证函数：$name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}

$script:Checks = 0
$script:ExpectedRepo = 'OWNER/REPO'
$script:Notices = New-Object 'System.Collections.Generic.List[string]'
$script:Requests = New-Object 'System.Collections.Generic.List[object]'
$script:SleepCalls = New-Object 'System.Collections.Generic.List[int]'
$script:RegistryReads = 0
$script:RegistryFails = $false
function Write-Info([string]$Text) { $script:Notices.Add($Text) }
function Write-Warn2([string]$Text) { $script:Notices.Add($Text) }
function Start-Sleep([int]$Milliseconds) { $script:SleepCalls.Add($Milliseconds) }
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Args = @())
  if ($Exe -ne 'gh' -or $script:Responses.Count -eq 0) { throw '发现未安排的原生命令调用。' }
  $script:Requests.Add(@($Args))
  return $script:Responses.Dequeue()
}
function Get-ItemProperty {
  param([string]$LiteralPath, [object]$ErrorAction)
  $script:RegistryReads++
  if ($script:RegistryFails) { throw '测试中的注册表读取异常' }
  return $script:RegistrySettings
}
function Set-Responses([object[]]$Items) {
  $script:Responses = New-Object 'System.Collections.Generic.Queue[object]'
  foreach ($item in $Items) { $script:Responses.Enqueue([pscustomobject]$item) }
  $script:Requests.Clear()
  $script:SleepCalls.Clear()
  $script:Notices.Clear()
}
function Assert-True([bool]$Condition, [string]$Name) {
  $script:Checks++
  if (-not $Condition) { throw "发布预检回归失败：$Name" }
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Name) {
  $message = $null
  try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
  Assert-True ($null -ne $message -and $message -match $Pattern) $Name
}
function New-ProxySettings([string]$Server, [int]$Enabled = 1, [string]$Bypass = '<local>;*.example.invalid') {
  return [pscustomobject]@{ ProxyEnable = $Enabled; ProxyServer = $Server; ProxyOverride = $Bypass }
}

$failures = @(
  @{ Code = 0; Text = ''; Kind = 'None' },
  @{ Code = 1; Text = 'Get https://api.github.com/user: EOF'; Kind = 'Network' },
  @{ Code = 1; Text = 'TLS handshake timeout'; Kind = 'Network' },
  @{ Code = 1; Text = 'dial tcp: no such host'; Kind = 'Network' },
  @{ Code = 1; Text = 'x509: certificate signed by unknown authority'; Kind = 'Network' },
  @{ Code = 1; Text = 'context deadline exceeded'; Kind = 'Network' },
  @{ Code = 1; Text = 'Bad credentials (HTTP 401)'; Kind = 'Credentials' },
  @{ Code = 4; Text = 'To get started, please run: gh auth login'; Kind = 'LoginRequired' },
  @{ Code = 1; Text = 'You are not logged into any GitHub hosts'; Kind = 'LoginRequired' },
  @{ Code = 1; Text = 'API rate limit exceeded (HTTP 403)'; Kind = 'RateLimit' },
  @{ Code = 1; Text = 'Too Many Requests (HTTP 429)'; Kind = 'RateLimit' },
  @{ Code = 1; Text = 'Resource not accessible by personal access token (HTTP 403)'; Kind = 'Permission' },
  @{ Code = 1; Text = 'Not Found (HTTP 404)'; Kind = 'NotFound' },
  @{ Code = 1; Text = 'release not found'; Kind = 'NotFound' },
  @{ Code = 1; Text = 'Service Unavailable (HTTP 503)'; Kind = 'Service' },
  @{ Code = 1; Text = 'The token in keyring is invalid'; Kind = 'Unknown' }
)
foreach ($case in $failures) {
  Assert-True ((Get-GitHubFailureKind $case.Code $case.Text) -eq $case.Kind) "错误分类：$($case.Kind)"
}
Assert-True ((Get-GitHubFailureMessage 'Network') -notmatch 'gh auth login|尚未配置登录|凭据已失效') '网络异常不要求重新登录'
Assert-True ((Get-GitHubFailureMessage 'RateLimit') -notmatch 'gh auth login') '限额不要求重新登录'
Assert-True ((Get-GitHubFailureMessage 'Unknown') -match '尚未确认') '未知故障不猜测账号状态'

Set-Responses @(@{Code=1; Out='EOF'}, @{Code=0; Out='{}'})
$read = Invoke-GitHubRead -Arguments @('api', '--hostname', 'github.com', 'user')
Assert-True ($read.Code -eq 0 -and $read.Attempts -eq 2) '网络恢复后重试成功'
Assert-True ($script:Requests.Count -eq 2 -and $script:SleepCalls[0] -eq 600) '重试次数与间隔'
Set-Responses @(@{Code=1; Out='HTTP 503'}, @{Code=1; Out='EOF'}, @{Code=0; Out='{}'})
$read = Invoke-GitHubRead -Arguments @('api', 'user')
Assert-True ($read.Attempts -eq 3 -and $read.Code -eq 0) '服务错误后第三次恢复'
Assert-True (($script:SleepCalls -join ',') -eq '600,1200') '渐进重试间隔'
Set-Responses @(@{Code=1; Out='EOF'}, @{Code=1; Out='EOF'}, @{Code=1; Out='EOF'})
$read = Invoke-GitHubRead -Arguments @('api', 'user')
Assert-True ($read.Kind -eq 'Network' -and $read.Attempts -eq 3 -and $script:Requests.Count -eq 3) '连续网络失败有上限'
foreach ($case in @('HTTP 401', 'HTTP 403', 'HTTP 429', 'API rate limit exceeded (HTTP 403)', 'HTTP 404', 'unrecognized error')) {
  Set-Responses @(@{Code=1; Out=$case})
  $read = Invoke-GitHubRead -Arguments @('api', 'user')
  Assert-True ($script:Requests.Count -eq 1 -and $script:SleepCalls.Count -eq 0) "立即停止：$case"
}

Set-Responses @(@{Code=0; Out='{"login":"release-user","id":123}'})
$identity = Get-PublishGitHubIdentity
Assert-True ($identity.login -eq 'release-user' -and $identity.id -eq 123) '活动账号核验'
$identityArguments = $script:Requests[0] -join ' '
Assert-True ($identityArguments -eq 'api --hostname github.com user --jq {login,id}') "仅查询 GitHub.com 身份且不读 token（实参：$identityArguments）"
foreach ($invalid in @('{}', '{"login":"release-user","id":true}', '{"login":"bad login","id":123}', '{"login":"release-user","id":0}', 'null', 'not-json')) {
  Set-Responses @(@{Code=0; Out=$invalid})
  Assert-Throws { Get-PublishGitHubIdentity } '信息不完整|格式异常|空结果' '账号数据异常时停止'
}
Set-Responses @(@{Code=1; Out='EOF PRIVATE_SENTINEL'}, @{Code=1; Out='EOF'}, @{Code=1; Out='EOF'})
Assert-Throws { Get-PublishGitHubIdentity } '连接异常' '身份查询网络故障保留分类'
Assert-True (($script:Notices -join ' ') -notmatch 'PRIVATE_SENTINEL') '诊断不回显原始响应'

$validRepository = '{"full_name":"OWNER/REPO","private":false,"default_branch":"main","permissions":{"admin":true,"push":true}}'
Set-Responses @(@{Code=0; Out=$validRepository})
$repo = Get-PublishGitHubRepository
Assert-True ($repo.permissions.push -eq $true) '实际仓库权限通过'
Assert-True (($script:Requests[0] -join ' ') -match '^api --hostname github.com repos/OWNER/REPO ') '仓库权限也固定 GitHub.com'
foreach ($invalid in @('{}', '{"full_name":"OTHER/REPO","private":false,"default_branch":"main","permissions":{"push":true}}', '{"full_name":"OWNER/REPO","private":false,"default_branch":"main"}')) {
  Set-Responses @(@{Code=0; Out=$invalid})
  Assert-Throws { Get-PublishGitHubRepository } '信息不完整' '仓库响应缺失时停止'
}
foreach ($push in @('false', '"true"', 'null')) {
  $body = '{"full_name":"OWNER/REPO","private":false,"default_branch":"main","permissions":{"push":' + $push + '}}'
  Set-Responses @(@{Code=0; Out=$body})
  Assert-Throws { Get-PublishGitHubRepository } '没有写权限' '未确认写权限时停止'
}
Set-Responses @(@{Code=1; Out='EOF'}, @{Code=1; Out='EOF'}, @{Code=1; Out='EOF'})
Assert-Throws { Get-PublishGitHubRepository } '连接异常' '仓库查询失败不静默跳过'

$proxy = Get-PublishSystemProxy (New-ProxySettings '127.0.0.1:7897')
Assert-True ($proxy.Https -eq 'http://127.0.0.1:7897' -and $proxy.Http -eq $proxy.Https) '单地址系统代理'
Assert-True ($proxy.NoProxy -eq 'localhost,127.0.0.1,::1,*.example.invalid') '继承代理排除表'
$proxy = Get-PublishSystemProxy (New-ProxySettings 'http=127.0.0.1:8000; https=127.0.0.1:9000')
Assert-True ($proxy.Https -eq 'http://127.0.0.1:9000' -and $proxy.Http -eq 'http://127.0.0.1:8000') '按协议系统代理'
$proxy = Get-PublishSystemProxy (New-ProxySettings 'https=https://proxy.example.invalid:8443')
Assert-True ($proxy.Https -eq 'https://proxy.example.invalid:8443' -and -not $proxy.Http) '已有协议保持原样'
$proxy = Get-PublishSystemProxy (New-ProxySettings '[::1]:7897')
Assert-True (([uri]$proxy.Https).Host -eq ([uri]'http://[::1]:7897').Host -and ([uri]$proxy.Https).Port -eq 7897) 'IPv6 代理地址'
Assert-True ($null -eq (Get-PublishSystemProxy (New-ProxySettings '127.0.0.1:7897' 0))) '关闭的系统代理不启用'
Assert-True ($null -eq (Get-PublishSystemProxy (New-ProxySettings 'http=127.0.0.1:7897'))) '仅 HTTP 代理不扩展到 HTTPS'
Assert-True ($null -eq (Get-PublishSystemProxy $null)) '缺少系统代理'
foreach ($invalid in @('', 'not a proxy', 'socks5://127.0.0.1:7897', 'http://proxy.example.invalid/path', 'http://proxy.example.invalid/?query=1')) {
  Assert-True ($null -eq (Get-PublishSystemProxy (New-ProxySettings $invalid))) '异常或未支持的代理格式'
}

$proxyVariables = @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY')
$saved = @{}
foreach ($name in $proxyVariables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  foreach ($name in $proxyVariables) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  $script:RegistrySettings = New-ProxySettings '127.0.0.1:7897'
  $script:RegistryReads = 0
  Initialize-PublishNetwork
  Assert-True ($env:HTTPS_PROXY -eq 'http://127.0.0.1:7897' -and $env:HTTP_PROXY -eq $env:HTTPS_PROXY) '双击发布继承代理'
  Assert-True ($script:RegistryReads -eq 1 -and $env:NO_PROXY -match 'example.invalid') '仅从系统读取静态代理'
  foreach ($explicit in @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')) {
    foreach ($name in $proxyVariables) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    [Environment]::SetEnvironmentVariable($explicit, 'http://explicit.example.invalid:8123', 'Process')
    $script:RegistryReads = 0
    Initialize-PublishNetwork
    Assert-True ($script:RegistryReads -eq 0 -and [Environment]::GetEnvironmentVariable($explicit, 'Process') -eq 'http://explicit.example.invalid:8123') '显式环境代理优先'
  }
  foreach ($name in $proxyVariables) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  $env:NO_PROXY = 'custom.example.invalid'
  Initialize-PublishNetwork
  Assert-True ($env:NO_PROXY -eq 'custom.example.invalid') '显式 NO_PROXY 保持原样'
  foreach ($name in $proxyVariables) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  $script:RegistryFails = $true
  Initialize-PublishNetwork
  Assert-True (-not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY) '注册表读取失败不改网络设置'
} finally {
  foreach ($name in $proxyVariables) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
Write-Host "[Postman 汉化] 发布预检回归通过（$($script:Checks) 项）。"
