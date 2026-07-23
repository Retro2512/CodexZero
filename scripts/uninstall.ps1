[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
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
