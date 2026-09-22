[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexZero'),
    [switch]$NoLaunch,
    [switch]$SkipShortcuts
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PackageRoot).Path
$root = [IO.Path]::GetFullPath($InstallRoot)
foreach ($file in @('CodexZero.exe', 'local-build.json', 'desktop\ChatGPT.exe', 'runtime\node.exe', 'provider-runtime\codex-custom-models.exe', 'assets\codexzero.ico')) {
    if (!(Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw "Incomplete desktop package: $file" }
}
$version = (Get-Content -Raw -LiteralPath (Join-Path $source 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid desktop version.' }
if ($source.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $root.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $source -eq $root) {
    throw 'Extract the download outside the installation folder.'
}
# A failed copy never replaces the active build. Previous builds remain available.
$relative = 'updates\' + $version + '-' + [guid]::NewGuid().ToString('N')
$destination = Join-Path $root $relative
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
if (!(Test-Path -LiteralPath (Join-Path $root 'CodexZero.exe'))) {
    Copy-Item -LiteralPath (Join-Path $destination 'CodexZero.exe') -Destination $root
}
New-Item -ItemType Directory -Path (Join-Path $root 'assets') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $destination 'assets\codexzero.ico') -Destination (Join-Path $root 'assets') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-desktop.ps1') -Destination $root -Force
[IO.File]::WriteAllText((Join-Path $root 'desktop-install.json'), '{"product":"CodexZero.Desktop","installer":"archive"}', [Text.UTF8Encoding]::new($false))
$pointer = Join-Path $root 'current-build.txt'
$temporary = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($temporary, $relative, [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $pointer) {
    $backup = Join-Path $root ('.previous-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::Replace($temporary, $pointer, $backup)
    [IO.File]::Delete($backup)
}
else { [IO.File]::Move($temporary, $pointer) }
if (!$SkipShortcuts) {
    & (Join-Path $destination 'scripts\install-codexzero-shortcuts.ps1') -BuildRoot $root
}
if (!$NoLaunch) { Start-Process -FilePath (Join-Path $root 'CodexZero.exe') -WorkingDirectory $root -WindowStyle Hidden }
Write-Output 'CodexZero installed.'
