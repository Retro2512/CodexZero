$ErrorActionPreference = 'Stop'
# The progress display slows downloads considerably in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'
$asset = 'CodexZero-Setup-windows-x64.exe'
$repo = 'Retro2512/CodexZero'
$version = if ($env:CODEX_ZERO_VERSION) { $env:CODEX_ZERO_VERSION } else { 'latest' }
if ($version -ne 'latest') {
    if ($version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') {
        throw 'Invalid CodexZero release version.'
    }
    if (-not $version.StartsWith('v')) { $version = "v$version" }
}
$verifyAttestation = if ($env:CODEX_ZERO_VERIFY_ATTESTATION) { $env:CODEX_ZERO_VERIFY_ATTESTATION } else { '0' }
if ($verifyAttestation -notin @('0', '1')) { throw 'CODEX_ZERO_VERIFY_ATTESTATION must be 0 or 1.' }
$url = if ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download/$asset"
} else {
    "https://github.com/$repo/releases/download/$version/$asset"
}
if ($env:CODEX_ZERO_BOOTSTRAP_PLAN -eq '1') {
    Write-Output $url
    return
}
$temp = Join-Path ([IO.Path]::GetTempPath()) "codex-zero-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $installer = Join-Path $temp $asset
    $checksum = Join-Path $temp "$asset.sha256"
    Write-Host 'Downloading CodexZero...'
    Invoke-WebRequest -Headers @{ 'User-Agent' = 'CodexZero installer' } -Uri $url -OutFile $installer -UseBasicParsing
    Invoke-WebRequest -Headers @{ 'User-Agent' = 'CodexZero installer' } -Uri "$url.sha256" -OutFile $checksum -UseBasicParsing
    $expected = ((Get-Content -Raw -LiteralPath $checksum).Trim() -split '\s+')[0]
    $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or $actual -ne $expected) {
        throw 'CodexZero installer checksum verification failed.'
    }
    if ($verifyAttestation -eq '1') {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            throw 'GitHub CLI is required to verify the release attestation.'
        }
        & gh attestation verify $installer --repo $repo --signer-workflow "$repo/.github/workflows/release.yml"
        if ($LASTEXITCODE -ne 0) { throw 'CodexZero release attestation verification failed.' }
    }
    Write-Host 'Installing CodexZero. Setup shows its progress and opens CodexZero when it is done.'
    $process = Start-Process -FilePath $installer -ArgumentList '/SP-', '/SILENT' -PassThru
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "CodexZero installation failed ($($process.ExitCode))." }
    Write-Host 'CodexZero is installed.'
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTemp) -match '^codex-zero-[0-9a-fA-F-]{36}$') {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
