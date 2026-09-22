[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$DesktopBinary,
    [string]$UpstreamUrl,
    [string]$UpstreamSha256
)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackageRoot).Path
if (!$DesktopBinary) {
    # Release inputs are pinned, never resolved from a mutable latest URL.
    $uri = [uri]$UpstreamUrl
    $officialHost = $uri.Host -eq 'persistent.oaistatic.com' -or $uri.Host -eq 'cdn.openai.com' -or $uri.Host.EndsWith('.delivery.mp.microsoft.com')
    if ($uri.Scheme -ne 'https' -or !$officialHost) {
        throw 'Provide an official HTTPS desktop package URL.'
    }
    if ($UpstreamSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Provide the pinned desktop SHA256.' }
    $staging = Join-Path ([IO.Path]::GetTempPath()) ('codexzero-desktop-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    $archive = Join-Path $staging 'desktop.zip'
    Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $UpstreamSha256) { throw 'Desktop package checksum mismatch.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $prefix = [IO.Path]::GetFullPath((Join-Path $staging 'extracted')).TrimEnd('\') + '\'
        $size = 0L
        foreach ($entry in $zip.Entries) {
            $target = [IO.Path]::GetFullPath([IO.Path]::Combine($prefix, $entry.FullName))
            $size += $entry.Length
            if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.Contains(':') -or $size -gt 4GB) {
                throw 'Invalid desktop archive.'
            }
        }
    } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $staging 'extracted')
    $DesktopBinary = Join-Path $staging 'extracted\app\ChatGPT.exe'
}
& (Join-Path $package 'scripts\build-provider-local.ps1') -OutputDirectory $OutputDirectory -DesktopBinary $DesktopBinary
if ($LASTEXITCODE -ne 0) { throw 'Desktop assembly failed.' }
foreach ($file in @('README.md', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $package $file) -Destination $OutputDirectory
}
# Keep the original archive layout usable by the CLI installer as well.
& (Join-Path $OutputDirectory 'runtime\node.exe') (Join-Path $OutputDirectory 'scripts\verify-complete-desktop.mjs') $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Desktop verification failed.' }
