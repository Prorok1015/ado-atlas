# Bundle ADO Atlas into dist\ado-atlas-extension.zip, ready for the Chrome Web Store.
# Entries are added with explicit forward-slash names because Windows PowerShell
# 5.1 (.NET Framework) writes backslashes via both Compress-Archive AND
# ZipFile.CreateFromDirectory, which produces an invalid package that Chrome
# can't unpack (vendor/ and icons/ paths break). Only runtime files are included
# — no tests, package.json, or docs.
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$dist  = Join-Path $root 'dist'
$out   = Join-Path $dist 'ado-atlas-extension.zip'
$files = @('manifest.json','background.js','index.html','lib.js','api.js','app.js','app.css','README.md','LICENSE','THIRD-PARTY-NOTICES.md')
$dirs  = @('vendor','icons')

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Path $dist | Out-Null

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  foreach ($f in $files) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $f), $f) | Out-Null
  }
  foreach ($d in $dirs) {
    Get-ChildItem -Path (Join-Path $root $d) -Recurse -File | ForEach-Object {
      $entry = $_.FullName.Substring($root.Length + 1).Replace('\', '/')   # forward-slash entry name
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry) | Out-Null
    }
  }
} finally { $zip.Dispose() }

$kb = [math]::Round((Get-Item $out).Length / 1KB)
Write-Host "Built $out ($kb KB)"
