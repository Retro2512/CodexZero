[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexZero'),
    [string]$DesktopPackage,
    [ValidateSet('archive', 'setup')][string]$Installer = 'archive',
    [switch]$NoLaunch,
    [switch]$SkipShortcuts
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PackageRoot).Path
$root = [IO.Path]::GetFullPath($InstallRoot)
# Release packages carry CodexZero only. A local build may already be complete.
$complete = Test-Path -LiteralPath (Join-Path $source 'CodexZero.exe')
$required = if ($complete) {
    @('CodexZero.exe', 'local-build.json', 'desktop\ChatGPT.exe', 'runtime\node.exe', 'provider-runtime\codex-custom-models.exe', 'assets\codexzero.ico')
} else {
    @('runtime\node.exe', 'assets\codexzero.ico', 'scripts\build-provider-local.ps1', 'scripts\resolve-desktop.ps1', 'scripts\desktop-upstream.json')
}
foreach ($file in $required) {
    if (!(Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw "Incomplete desktop package: $file" }
}
$version = (Get-Content -Raw -LiteralPath (Join-Path $source 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid desktop version.' }
if ($source.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $root.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $source -eq $root) {
    throw 'Extract the download outside the installation folder.'
}
$prefix = $root.TrimEnd('\') + '\'
if ($Installer -eq 'archive' -and (Test-Path -LiteralPath $root)) {
    foreach ($process in Get-CimInstance Win32_Process) {
        if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Close CodexZero before continuing.'
        }
    }
}
# A failed build never replaces the active one.
$name = $version + '-' + [guid]::NewGuid().ToString('N')
$relative = 'updates\' + $name
$destination = Join-Path $root $relative
New-Item -ItemType Directory -Path (Join-Path $root 'updates') -Force | Out-Null
try {
    if ($complete) {
        New-Item -ItemType Directory -Path $destination | Out-Null
        Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
    } else {
        & (Join-Path $source 'scripts\build-provider-local.ps1') -OutputDirectory $destination -DesktopPackage $DesktopPackage | Out-Null
        if (!(Test-Path -LiteralPath (Join-Path $destination 'CodexZero.exe') -PathType Leaf)) { throw 'CodexZero could not be set up.' }
    }
} catch {
    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
}
if (!(Test-Path -LiteralPath (Join-Path $root 'CodexZero.exe'))) {
    Copy-Item -LiteralPath (Join-Path $destination 'CodexZero.exe') -Destination $root
}
if ($Installer -eq 'archive') {
    New-Item -ItemType Directory -Path (Join-Path $root 'assets') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $destination 'assets\codexzero.ico') -Destination (Join-Path $root 'assets') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-desktop.ps1') -Destination $root -Force
    [IO.File]::WriteAllText((Join-Path $root 'desktop-install.json'), '{"product":"CodexZero.Desktop","installer":"archive"}', [Text.UTF8Encoding]::new($false))
}
$pointer = Join-Path $root 'current-build.txt'
$temporary = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($temporary, $relative, [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $pointer) {
    $backup = Join-Path $root ('.previous-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::Replace($temporary, $pointer, $backup)
    [IO.File]::Delete($backup)
}
else { [IO.File]::Move($temporary, $pointer) }
# CodexZero is closed, so earlier builds are no longer in use.
foreach ($previous in Get-ChildItem -LiteralPath (Join-Path $root 'updates') -Directory -Force) {
    if ($previous.Name -ne $name -and $previous.Name -match '^\d+\.\d+\.\d+-[0-9a-f]{32}$' -and
        !($previous.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $previous.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (!$SkipShortcuts) {
    & (Join-Path $destination 'scripts\install-codexzero-shortcuts.ps1') -BuildRoot $root
}
if (!$NoLaunch) { Start-Process -FilePath (Join-Path $root 'CodexZero.exe') -WorkingDirectory $root -WindowStyle Hidden }
Write-Output 'CodexZero installed.'
