[CmdletBinding()]
param(
    [string]$StagingRoot,
    [string]$DesktopPackage,
    [switch]$SkipInstalled,
    [string]$Manifest,
    [string]$CacheRoot
)
# Resolves the official desktop application that CodexZero is assembled from.
# Releases never contain it. It comes from the matching installed app, a
# verified earlier download, or the pinned official package.
$ErrorActionPreference = 'Stop'
if (!$Manifest) { $Manifest = Join-Path $PSScriptRoot 'desktop-upstream.json' }
if (!$CacheRoot) { $CacheRoot = Join-Path $env:LOCALAPPDATA 'CodexZero\cache\desktop' }

$pin = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
$uri = [uri]$pin.url
$officialHost = $uri.Host -eq 'persistent.oaistatic.com' -or $uri.Host -eq 'cdn.openai.com'
if ($uri.Scheme -ne 'https' -or !$officialHost) { throw 'The desktop package must come from an official HTTPS address.' }
if ([string]$pin.version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Invalid desktop version.' }
if ([string]$pin.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid desktop checksum.' }
if ([string]$pin.publisherId -notmatch '^[a-z0-9]{13}$') { throw 'Invalid desktop publisher.' }
$size = [long]$pin.size
if ($size -le 0) { throw 'Invalid desktop size.' }

function Test-DesktopPackage([string]$Path) {
    if ((Get-Item -LiteralPath $Path).Length -ne $size) { return $false }
    # Avoid module loading so this also works under an inherited module path.
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
    $hash -eq $pin.sha256.ToUpperInvariant()
}

if (!$SkipInstalled) {
    $installed = $null
    try {
        $installed = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop |
            Where-Object { $_.Version -eq $pin.version -and $_.PublisherId -eq $pin.publisherId -and [string]$_.Architecture -eq 'X64' } |
            Select-Object -First 1
    } catch { $installed = $null }
    if ($installed) {
        $binary = Join-Path $installed.InstallLocation 'app\ChatGPT.exe'
        if (Test-Path -LiteralPath $binary -PathType Leaf) {
            Write-Output $binary
            return
        }
    }
}

$cached = Join-Path $CacheRoot "$($pin.version).msix"
$partial = "$cached.partial"
New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
if ($DesktopPackage) {
    if (!(Test-DesktopPackage $DesktopPackage)) { throw 'The downloaded desktop package failed verification.' }
    Move-Item -LiteralPath $DesktopPackage -Destination $cached -Force
}
if (!$StagingRoot) { throw 'StagingRoot is required.' }

if ((Test-Path -LiteralPath $cached) -and !(Test-DesktopPackage $cached)) {
    Remove-Item -LiteralPath $cached -Force
}
if (!(Test-Path -LiteralPath $cached)) {
    # Resume an interrupted download instead of starting again.
    if ((Test-Path -LiteralPath $partial) -and (Get-Item -LiteralPath $partial).Length -gt $size) {
        Remove-Item -LiteralPath $partial -Force
    }
    $current = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0 }
    if ($current -lt $size) {
        $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
        if (Test-Path -LiteralPath $curl -PathType Leaf) {
            & $curl --fail --location --silent --show-error --retry 5 --retry-delay 3 --continue-at - --output $partial $uri.AbsoluteUri
            if ($LASTEXITCODE -ne 0) { throw 'Could not download Codex desktop. Check your internet connection and try again.' }
        } else {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $partial -UseBasicParsing
        }
    }
    if (!(Test-DesktopPackage $partial)) {
        Remove-Item -LiteralPath $partial -Force
        throw 'The downloaded desktop package failed verification.'
    }
    Move-Item -LiteralPath $partial -Destination $cached -Force
}
# Keep one verified package so later updates do not download it again.
Get-ChildItem -LiteralPath $CacheRoot -File -Force |
    Where-Object { $_.FullName -ne $cached } |
    Remove-Item -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
$prefix = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\') + '\'
$zip = [IO.Compression.ZipFile]::OpenRead($cached)
try {
    $total = 0L
    foreach ($entry in $zip.Entries) {
        if (!$entry.FullName.StartsWith('app/', [StringComparison]::Ordinal)) { continue }
        # Package part names are percent-encoded, for example %40 for @.
        $name = [Uri]::UnescapeDataString($entry.FullName)
        $total += $entry.Length
        if ($name.Contains(':') -or $name.Contains('\') -or $total -gt 8GB) { throw 'Invalid desktop package.' }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($prefix, $name))
        if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid desktop package.' }
        if ($name.EndsWith('/')) {
            [void][IO.Directory]::CreateDirectory($target)
            continue
        }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
$binary = Join-Path $StagingRoot 'app\ChatGPT.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Invalid desktop package.' }
Write-Output $binary
