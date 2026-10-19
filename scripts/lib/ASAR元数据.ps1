# 只读读取 ASAR 包元数据；下载验证与发布预检共用。
function Read-PostmanAsarPackage {
  param([Parameter(Mandatory)][System.IO.Stream]$Stream)
  $reader = $null
  try {
    if (-not $Stream.CanRead -or -not $Stream.CanSeek -or $Stream.Length -lt 16) { throw '无效的 ASAR 流' }
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $reader = [System.IO.BinaryReader]::new($Stream, $utf8, $true)
    $Stream.Position = 0
    $sizePayload = $reader.ReadUInt32()
    $headerSize = $reader.ReadUInt32()
    $headerPayload = $reader.ReadUInt32()
    $jsonSize = $reader.ReadUInt32()
    if ($sizePayload -ne 4 -or $headerSize -lt 8 -or $headerSize -gt 16MB -or
        ($headerSize % 4) -ne 0 -or $headerPayload -ne ($headerSize - 4) -or
        $jsonSize -eq 0 -or $jsonSize -gt ($headerSize - 8) -or
        ($headerSize - 8 - $jsonSize) -gt 3 -or (8L + $headerSize) -gt $Stream.Length) {
      throw '无效的 ASAR 文件头'
    }
    $headerJson = $utf8.GetString($reader.ReadBytes([int]$jsonSize))
    if (-not $headerJson.TrimStart().StartsWith('{')) { throw '无效的 ASAR 索引对象' }
    $header = $headerJson | ConvertFrom-Json -ErrorAction Stop
    $entry = $header.files.'package.json'
    if ($null -eq $entry -or $entry.unpacked -or $null -ne $entry.link -or
        ($entry.size -isnot [int] -and $entry.size -isnot [long]) -or
        $entry.size -le 0 -or $entry.size -gt 1MB -or
        $entry.offset -isnot [string] -or $entry.offset -notmatch '^(0|[1-9][0-9]*)\z') {
      throw '无效的 package.json 索引'
    }
    $dataStart = 8L + $headerSize
    $offset = [long]$entry.offset
    if ($offset -gt ($Stream.Length - $dataStart - $entry.size)) { throw 'package.json 内容越界' }
    $Stream.Position = $dataStart + $offset
    $packageJson = $utf8.GetString($reader.ReadBytes([int]$entry.size))
    if (-not $packageJson.TrimStart().StartsWith('{')) { throw '无效的 package.json 对象' }
    return ($packageJson | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw 'app.asar 的 package.json 读取失败：文件头、索引或内容异常。'
  } finally {
    if ($reader) { $reader.Dispose() }
  }
}
