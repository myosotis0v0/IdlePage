$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
try {
  $version = (Get-Content -LiteralPath 'package.json' -Encoding UTF8 -Raw | ConvertFrom-Json).version
  $name = "IdlePage-$version-windows"
  $dist = Join-Path $project 'dist'
  $stage = Join-Path $dist $name
  $vsix = Join-Path $dist "idle-page-$version.vsix"
  if (Test-Path -LiteralPath $stage) { throw "Release staging directory already exists: $stage" }
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  & npx.cmd --yes '@vscode/vsce@4.0.0' package --no-dependencies --out $vsix
  if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed' }
  # A fresh stage prevents old local files from entering a release.
  New-Item -ItemType Directory -Path $stage | Out-Null
  $template = Join-Path $stage 'browser-extension-template'
  New-Item -ItemType Directory -Path $template | Out-Null
  foreach ($file in @('manifest.json','worker.js','bookshelf.js','login.js','catalog.js','chapter.js','content.js','status.html','status.js')) {
    Copy-Item -LiteralPath (Join-Path $project "browser-extension/$file") -Destination $template
  }
  Copy-Item -LiteralPath $vsix -Destination $stage
  Copy-Item -LiteralPath (Join-Path $project 'docs/INSTALL-RELEASE.md') -Destination (Join-Path $stage 'INSTALL.md')
  Copy-Item -LiteralPath (Join-Path $project 'README.md') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination $stage
  $hashes = foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName) {
    $relative = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
    "{0}  {1}" -f (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
  }
  [IO.File]::WriteAllLines((Join-Path $stage 'SHA256SUMS.txt'), $hashes, [Text.UTF8Encoding]::new($false))
  $archive = Join-Path $dist "$name.zip"
  Compress-Archive -LiteralPath $stage -DestinationPath $archive -Force
  $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$archive.sha256", "$archiveHash  $name.zip`n", [Text.UTF8Encoding]::new($false))
  Write-Output $archive
  Write-Output "SHA256: $archiveHash"
} finally { Pop-Location }
