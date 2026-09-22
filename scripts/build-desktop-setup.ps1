[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$IsccPath
)

$ErrorActionPreference = 'Stop'
$PackageRoot = [System.IO.Path]::GetFullPath($PackageRoot)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $PackageRoot -PathType Container)) {
    throw "PackageRoot does not exist: $PackageRoot"
}
if ($OutputDirectory.Equals($PackageRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($PackageRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside PackageRoot.'
}

foreach ($relative in @('runtime\node.exe', 'assets\codexzero.ico', 'bin\codex-zero.mjs', 'package.json',
    'scripts\install-desktop.ps1', 'scripts\build-provider-local.ps1', 'scripts\resolve-desktop.ps1', 'scripts\desktop-upstream.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relative) -PathType Leaf)) {
        throw "Required package file is missing: $relative"
    }
}
foreach ($relative in @('src', 'scripts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relative) -PathType Container)) {
        throw "Required package directory is missing: $relative"
    }
}
# Setup assembles the desktop on the user's computer. Never ship the app itself.
foreach ($relative in @('desktop', 'provider-runtime', 'CodexZero.exe', 'local-build.json')) {
    if (Test-Path -LiteralPath (Join-Path $PackageRoot $relative)) {
        throw "Package must not contain an assembled desktop: $relative"
    }
}
$package = Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'package.json') | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Package version is missing or invalid.'
}
$desktop = Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'scripts\desktop-upstream.json') | ConvertFrom-Json
$desktopUri = [uri]$desktop.url
if ($desktopUri.Scheme -ne 'https' -or $desktopUri.Host -notin @('persistent.oaistatic.com', 'cdn.openai.com') -or
    [string]$desktop.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]$desktop.version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or
    [string]$desktop.publisherId -notmatch '^[a-z0-9]{13}$' -or [long]$desktop.size -le 0) {
    throw 'The pinned desktop package is invalid.'
}

if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $IsccPath = $command.Source }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        if ($IsccPath -or [string]::IsNullOrWhiteSpace($base)) { continue }
        $candidate = Join-Path $base 'Inno Setup 6\ISCC.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $IsccPath = $candidate }
    }
}
if ([string]::IsNullOrWhiteSpace($IsccPath) -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
    throw 'Inno Setup 6 is required. Set IsccPath to ISCC.exe.'
}

$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$arguments = @('/Qp', "/DPackageRoot=$PackageRoot", "/DOutputDirectory=$OutputDirectory", "/DAppVersion=$version",
    "/DDesktopUrl=$($desktopUri.AbsoluteUri)", "/DDesktopSha256=$($desktop.sha256.ToLowerInvariant())", "/DDesktopSize=$([long]$desktop.size)",
    "/DDesktopVersion=$($desktop.version)", "/DDesktopPublisher=$($desktop.publisherId)",
    (Join-Path $PSScriptRoot 'windows-desktop.iss'))
& $IsccPath @arguments
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
$setupPath = Join-Path $OutputDirectory 'CodexZero-Setup-windows-x64.exe'
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw 'Inno Setup did not produce the desktop installer.'
}
Write-Output $setupPath
