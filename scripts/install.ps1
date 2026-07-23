[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipMonitor
)

$ErrorActionPreference = 'Stop'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$installRoot = Join-Path $codexHome 'codexzero'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $codexHome "backups\codexzero-install-$timestamp"
$sourceRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$sourceCore = Join-Path $sourceRoot 'dist\windows-x64\codex-zero-core.exe'
if (-not (Test-Path -LiteralPath $sourceCore)) {
    $sourceCore = Join-Path $sourceRoot 'work\codex-0.145.0-alpha.30\codex-rs\target\debug\codex.exe'
}
if (-not (Test-Path -LiteralPath $sourceCore)) {
    throw 'codex-zero-core.exe is missing. Download a release package or build the patched CLI first.'
}
$bundledNode = Join-Path $sourceRoot 'runtime\node.exe'
$nodeCommand = if (Test-Path -LiteralPath $bundledNode) {
    $bundledNode
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
    (Get-Command node).Source
} else {
    throw 'Node.js 20 or newer is required when installing from a source checkout.'
}

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
foreach ($path in @(
    (Join-Path $codexHome 'config.toml'),
    (Join-Path $codexHome 'codexzero.config.toml'),
    $installRoot
)) {
    if (Test-Path -LiteralPath $path) {
        Copy-Item -LiteralPath $path -Destination $backupRoot -Recurse -Force
    }
}

$appRoot = Join-Path $installRoot 'app'
$binRoot = Join-Path $installRoot 'bin'
New-Item -ItemType Directory -Force -Path $appRoot, $binRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'bin') -Destination $appRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'src') -Destination $appRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts') -Destination $appRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination $appRoot -Force
Copy-Item -LiteralPath $sourceCore -Destination (Join-Path $binRoot 'codex-zero-core.exe') -Force
if (Test-Path -LiteralPath $bundledNode) {
    Copy-Item -LiteralPath $bundledNode -Destination (Join-Path $binRoot 'node.exe') -Force
    $nodeCommand = Join-Path $binRoot 'node.exe'
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'config\codexzero.config.toml') `
    -Destination (Join-Path $codexHome 'codexzero.config.toml') -Force

$shimRoot = Join-Path $codexHome 'bin'
New-Item -ItemType Directory -Force -Path $shimRoot | Out-Null
$shim = @"
@echo off
"$nodeCommand" "$appRoot\bin\codex-zero.mjs" %*
"@
Set-Content -LiteralPath (Join-Path $shimRoot 'codex-zero.cmd') -Value $shim -Encoding ascii

$currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($currentUserPath -split ';' | Where-Object { $_ })
if ($parts -notcontains $shimRoot) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $shimRoot) -join ';'), 'User')
}
$env:Path = "$shimRoot;$env:Path"

& (Join-Path $binRoot 'codex-zero-core.exe') --strict-config --version
& (Join-Path $shimRoot 'codex-zero.cmd') doctor
if (-not $SkipMonitor) {
    & (Join-Path $shimRoot 'codex-zero.cmd') monitor --start
}

@{
    schema = 'codex-zero-install-v1'
    installed_at = (Get-Date).ToUniversalTime().ToString('o')
    package_root = $sourceRoot
    backup_root = $backupRoot
    stock_command = 'codex'
    rollback_command = 'codex-zero stock'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'install.json') -Encoding utf8

Write-Host ''
Write-Host 'CodexZero installed.'
Write-Host 'Run: codex-zero run'
Write-Host 'Desktop: codex-zero desktop'
Write-Host 'Savings: codex-zero savings'
Write-Host 'Stock rollback: codex-zero stock'
Write-Host "Backup: $backupRoot"
