$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsPath = [System.IO.Path]::GetFullPath((Join-Path $root '.tools\mailpit'))
if (-not $toolsPath.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid tools path.' }
$version = 'v1.31.6'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$hashes = @{
  amd64 = '5d5ad094bfb3bac9004f9d1105d2335fea9f8952c09951df73ae0a280e34d3b1'
  arm64 = 'c04c77ac9fd9da27c91259d0484b93b163e8534964682f543204cf3301a6b967'
}
New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
$exe = Join-Path $toolsPath 'mailpit.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  $zip = Join-Path $toolsPath "mailpit-$version-$arch.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/axllent/mailpit/releases/download/$version/mailpit-windows-$arch.zip" -OutFile $zip
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($zip))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($hash -ne $hashes[$arch]) { throw 'Mailpit archive integrity check failed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $toolsPath)
}
Write-Output 'Local test mail only; no email will be delivered to the Internet. Inbox: http://127.0.0.1:8025'
& $exe --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --database (Join-Path $toolsPath 'mailpit.db')
