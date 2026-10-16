param([switch]$VsixOnly)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
try {
  $version = (Get-Content -LiteralPath 'package.json' -Encoding UTF8 -Raw | ConvertFrom-Json).version
  $name = "IdlePage-$version-windows"
  $dist = Join-Path $project 'dist'
  $stage = Join-Path $dist $name
  $vsix = Join-Path $dist "idle-page-$version.vsix"
  if (-not $VsixOnly -and (Test-Path -LiteralPath $stage)) { throw "Release staging directory already exists: $stage" }
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  & npx.cmd --yes '@vscode/vsce@4.0.0' package --no-dependencies --out $vsix
  if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed' }
  if ($VsixOnly) { Write-Output $vsix; return }
  # A fresh stage prevents old local files from entering a release.
  New-Item -ItemType Directory -Path $stage | Out-Null
  $template = Join-Path $stage 'browser-extension-template'
  New-Item -ItemType Directory -Path $template | Out-Null
  foreach ($file in @('manifest.json','worker.js','remote.js','bookshelf.js','login.js','catalog.js','chapter.js','content.js','status.html','status.js')) {
    Copy-Item -LiteralPath (Join-Path $project "browser-extension/$file") -Destination $template
  }
  Copy-Item -LiteralPath $vsix -Destination $stage
  Copy-Item -LiteralPath (Join-Path $project 'docs/INSTALL-RELEASE.md') -Destination (Join-Path $stage 'INSTALL.md')
  Copy-Item -LiteralPath (Join-Path $project 'README.md') -Destination $stage
  $media = Join-Path $stage 'media'
  New-Item -ItemType Directory -Path $media | Out-Null
  foreach ($file in @('statusbar-preview.png','catalog-preview.png')) {
    Copy-Item -LiteralPath (Join-Path $project "media/$file") -Destination $media
  }
  Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination $stage
  $archive = Join-Path $dist "$name.zip"
  Compress-Archive -LiteralPath $stage -DestinationPath $archive -Force
  Write-Output $archive
} finally { Pop-Location }
