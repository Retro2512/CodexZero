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

foreach ($relative in @('CodexZero.exe', 'desktop\ChatGPT.exe', 'runtime\node.exe',
    'assets\codexzero.ico', 'bin\codex-zero.mjs', 'package.json', 'local-build.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relative) -PathType Leaf)) {
        throw "Required package file is missing: $relative"
    }
}
foreach ($relative in @('provider-runtime', 'src', 'scripts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relative) -PathType Container)) {
        throw "Required package directory is missing: $relative"
    }
}
$package = Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'package.json') | ConvertFrom-Json
$null = Get-Content -Raw -LiteralPath (Join-Path $PackageRoot 'local-build.json') | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Package version is missing or invalid.'
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
    (Join-Path $PSScriptRoot 'windows-desktop.iss'))
& $IsccPath @arguments
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
$setupPath = Join-Path $OutputDirectory 'CodexZero-Setup-windows-x64.exe'
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw 'Inno Setup did not produce the desktop installer.'
}
Write-Output $setupPath
