$ErrorActionPreference = 'Stop'
# The progress display slows downloads considerably in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'
$asset = 'CodexZero-Setup-windows-x64.exe'
$url = "https://github.com/Retro2512/CodexZero/releases/latest/download/$asset"
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
    Write-Host 'Installing CodexZero. Setup shows its progress and opens CodexZero when it is done.'
    $process = Start-Process -FilePath $installer -ArgumentList '/SP-', '/SILENT' -PassThru
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "CodexZero installation failed ($($process.ExitCode))." }
    Write-Host 'CodexZero is installed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
