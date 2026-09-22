[CmdletBinding(SupportsShouldProcess)]
param([switch]$CliOnly)

$ErrorActionPreference = 'Stop'
if (!$CliOnly -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'CodexZero.exe'))) {
    $desktopRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodexZero'
    if (Test-Path -LiteralPath (Join-Path $desktopRoot 'unins000.exe')) {
        if ($PSCmdlet.ShouldProcess($desktopRoot, 'Uninstall CodexZero')) {
            Start-Process -FilePath (Join-Path $desktopRoot 'unins000.exe') -WindowStyle Hidden
        }
    } elseif ($PSCmdlet.ShouldProcess($desktopRoot, 'Uninstall CodexZero')) {
        & (Join-Path $PSScriptRoot 'uninstall-desktop.ps1') -InstallRoot $desktopRoot
    }
    return
}
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$installRoot = Join-Path $codexHome 'codexzero'
$shim = Join-Path $codexHome 'bin\codex-zero.cmd'

if (Test-Path -LiteralPath $shim) {
    & $shim monitor --stop
}
if ($PSCmdlet.ShouldProcess($installRoot, 'Remove CodexZero installation')) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $shim -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $codexHome 'codexzero.config.toml') `
        -Force -ErrorAction SilentlyContinue
}
Write-Host 'CodexZero removed. Stock Codex was not changed.'
