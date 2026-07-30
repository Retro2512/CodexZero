[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipMonitor,
    [ValidateSet('ask', 'safe', 'standard', 'max-save', 'focused', 'command-output', 'full-lean')]
    [string]$Mode = 'ask'
)

$ErrorActionPreference = 'Stop'
if ($Mode -eq 'command-output') { $Mode = 'safe' }
if ($Mode -eq 'full-lean') { $Mode = 'max-save' }
if ($Mode -eq 'ask') {
    Write-Host ''
    Write-Host 'Choose a CodexZero mode:'
    Write-Host '  1. Standard (default) - use the lean prompt and direct Codex tools'
    Write-Host '  2. Focused - Standard plus scoped batching for tool-heavy work'
    Write-Host '  3. Safe - preserve the direct Codex tool surface and model instructions'
    try {
        $selection = Read-Host 'Select 1, 2, or 3 [1]'
    } catch [System.Management.Automation.PSInvalidOperationException] {
        $selection = ''
    }
    $selection = if ($null -eq $selection) { '' } else { $selection.Trim() }
    $Mode = if ($selection -eq '2') {
        'focused'
    } elseif ($selection -eq '3') {
        'safe'
    } else {
        'standard'
    }
}
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$installRoot = Join-Path $codexHome 'codexzero'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $codexHome "backups\codexzero-install-$timestamp"
$sourceRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$sourcePromptRoot = Join-Path $sourceRoot 'prompts'
$sourceLeanPrompt = Join-Path $sourcePromptRoot 'codex-core-lean-v1.md'
if ($Mode -in @('standard', 'max-save', 'focused') -and -not (Test-Path -LiteralPath $sourceLeanPrompt)) {
    throw 'The selected mode requires a model prompt that is missing from this package.'
}
$existingShim = Join-Path $codexHome 'bin\codex-zero.cmd'
$monitorPidPath = Join-Path $installRoot 'monitor.pid'
$sourceCore = Join-Path $sourceRoot 'dist\windows-x64\codex-zero-core.exe'
if (-not (Test-Path -LiteralPath $sourceCore)) {
    $sourceCore = Join-Path $sourceRoot 'work\codex-0.146.0\codex-rs\target\debug\codex.exe'
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

# Windows cannot replace the bundled Node executable while the previous
# savings monitor is using it. Stop only CodexZero's recorded monitor, then
# wait for that process to release the file before updating the installation.
$previousMonitorPid = $null
if (Test-Path -LiteralPath $monitorPidPath) {
    $parsedPid = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $monitorPidPath).Trim(), [ref]$parsedPid)) {
        $previousMonitorPid = $parsedPid
    }
}
if ($previousMonitorPid -and (Test-Path -LiteralPath $existingShim)) {
    & $existingShim monitor --stop
    if ($LASTEXITCODE -ne 0) {
        throw 'The existing CodexZero savings monitor could not be stopped.'
    }
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Get-Process -Id $previousMonitorPid -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -ge $stopDeadline) {
            throw 'The existing CodexZero savings monitor did not stop within 15 seconds.'
        }
        Start-Sleep -Milliseconds 100
    }
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
$promptRoot = Join-Path $installRoot 'prompts'
New-Item -ItemType Directory -Force -Path $appRoot, $binRoot, $promptRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'bin') -Destination $appRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'src') -Destination $appRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts') -Destination $appRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination $appRoot -Force
if (Test-Path -LiteralPath $sourcePromptRoot) {
    Copy-Item -Path (Join-Path $sourcePromptRoot '*') -Destination $promptRoot -Recurse -Force
}
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

@{
    schema = 'codex-zero-install-v4'
    installed_at = (Get-Date).ToUniversalTime().ToString('o')
    package_root = $sourceRoot
    backup_root = $backupRoot
    mode = $Mode
    lean_prompt = if ($Mode -in @('standard', 'max-save', 'focused')) {
        Join-Path $promptRoot 'codex-core-lean-v1.md'
    } else {
        $null
    }
    stock_command = 'codex'
    rollback_command = 'codex-zero stock'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'install.json') -Encoding utf8

& (Join-Path $binRoot 'codex-zero-core.exe') --strict-config --version
& (Join-Path $shimRoot 'codex-zero.cmd') run --strict-config --version
& (Join-Path $shimRoot 'codex-zero.cmd') doctor
if (-not $SkipMonitor) {
    & (Join-Path $shimRoot 'codex-zero.cmd') monitor --start
}

Write-Host ''
Write-Host 'CodexZero installed.'
Write-Host "Mode: $Mode"
Write-Host 'Run: codex-zero run'
Write-Host 'Change mode: codex-zero mode safe|standard|max-save|focused'
Write-Host 'Desktop: codex-zero desktop'
Write-Host 'Savings: codex-zero savings'
Write-Host 'Stock rollback: codex-zero stock'
Write-Host "Backup: $backupRoot"
