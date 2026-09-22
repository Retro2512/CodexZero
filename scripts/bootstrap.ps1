[CmdletBinding()]
param(
    [ValidateSet('ask', 'safe', 'standard', 'max-save', 'focused', 'command-output', 'full-lean')]
    [string]$Mode = 'ask'
)

$ErrorActionPreference = 'Stop'
# The progress display slows downloads considerably in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'
$repo = 'Retro2512/CodexZero'
$release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'CodexZero installer' } `
    -Uri "https://api.github.com/repos/$repo/releases/latest"
$setup = $release.assets | Where-Object { $_.name -eq 'CodexZero-Setup-windows-x64.exe' } | Select-Object -First 1
if ($setup) {
    $checksum = $release.assets | Where-Object { $_.name -eq 'CodexZero-Setup-windows-x64.exe.sha256' } | Select-Object -First 1
    if (!$checksum) { throw 'The desktop installer checksum is missing.' }
    $temp = Join-Path ([IO.Path]::GetTempPath()) "codex-zero-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $temp | Out-Null
    $installer = Join-Path $temp 'CodexZero-Setup-windows-x64.exe'
    Write-Host 'Downloading CodexZero...'
    Invoke-WebRequest -Uri $setup.browser_download_url -OutFile $installer
    $checksumPath = Join-Path $temp 'setup.sha256'
    Invoke-WebRequest -Uri $checksum.browser_download_url -OutFile $checksumPath
    $expected = ((Get-Content -Raw -LiteralPath $checksumPath).Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expected) {
        throw 'CodexZero installer checksum verification failed.'
    }
    Write-Host 'Installing CodexZero. Setup shows its progress and opens CodexZero when it is done.'
    $process = Start-Process -FilePath $installer -ArgumentList '/SP-', '/SILENT' -Wait -PassThru
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    if ($process.ExitCode -ne 0) { throw "CodexZero installation failed ($($process.ExitCode))." }
    Write-Host 'CodexZero is installed.'
    return
}
$asset = $release.assets | Where-Object { $_.name -eq 'codex-zero-windows-x64.zip' } | Select-Object -First 1
if (-not $asset) { throw 'The latest release has no Windows x64 package.' }
$checksumAsset = $release.assets | Where-Object { $_.name -eq 'codex-zero-windows-x64.zip.sha256' } | Select-Object -First 1
if (-not $checksumAsset) { throw 'The latest release has no Windows package checksum.' }
$temp = Join-Path ([IO.Path]::GetTempPath()) "codex-zero-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $temp | Out-Null
$archive = Join-Path $temp 'codex-zero.zip'
Invoke-WebRequest -Headers @{ 'User-Agent' = 'CodexZero installer' } `
    -Uri $asset.browser_download_url -OutFile $archive
$checksumFile = Join-Path $temp 'codex-zero.zip.sha256'
Invoke-WebRequest -Headers @{ 'User-Agent' = 'CodexZero installer' } `
    -Uri $checksumAsset.browser_download_url -OutFile $checksumFile
$expected = ((Get-Content -Raw -LiteralPath $checksumFile).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'CodexZero package checksum verification failed.' }
Expand-Archive -LiteralPath $archive -DestinationPath $temp
$installer = Join-Path $temp 'scripts\install.ps1'
$installerCommand = Get-Command -Name $installer
if ($installerCommand.Parameters.ContainsKey('Mode')) {
    $installerText = Get-Content -Raw -LiteralPath $installer
    $resolvedMode = $Mode
    if ($installerText -notmatch "'max-save'") {
        $resolvedMode = switch ($Mode) {
            'max-save' { 'full-lean' }
            'full-lean' { 'full-lean' }
            default { 'command-output' }
        }
    }
    & $installer -PackageRoot $temp -Mode $resolvedMode
} else {
    & $installer -PackageRoot $temp
}
