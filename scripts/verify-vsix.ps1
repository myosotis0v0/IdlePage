$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $project "dist/idle-page-$version.vsix"))
try {
  $names = @($archive.Entries.FullName)
  foreach ($name in $names) {
    if ($name -match '(?i)(^|/)(pairing\.(js|json)|\.local|node_modules|labs)(/|$)|sha256|\.map$') {
      throw "Unexpected release file: $name"
    }
  }
  foreach ($name in @('extension/package.json','extension/out/extension.cjs','extension/browser-extension/manifest.json','extension/browser-extension/worker.js','extension/browser-extension/remote.js')) {
    if ($names -cnotcontains $name) { throw "Missing release file: $name" }
  }
  $reader = [System.IO.StreamReader]::new($archive.GetEntry('extension/package.json').Open())
  try { $packaged = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($packaged.version -cne $version) { throw 'Packaged version mismatch' }
  Write-Output "Verified idle-page-$version.vsix ($($names.Count) entries)"
} finally { $archive.Dispose() }
