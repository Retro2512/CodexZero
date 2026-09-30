[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Handoff,
    [Parameter(Mandatory = $true)][string]$LaunchRoot,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][string]$ParentStartTicks,
    [Parameter(Mandatory = $true)][string]$ReadyFile,
    [Parameter(Mandatory = $true)][string]$CancelFile,
    [switch]$ShowFailureDialog
)
$ErrorActionPreference = 'Stop'

function Quote-PathArgument([string]$Value) {
    # These are Windows paths, not shell expressions. Quotes are invalid in
    # paths; double trailing backslashes for the native argument parser.
    if ($Value.Contains('"')) { throw 'Invalid update path.' }
    '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}

$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-PathArgument $Handoff),
    '-LaunchRoot', (Quote-PathArgument $LaunchRoot),
    '-BuildRoot', (Quote-PathArgument $BuildRoot),
    '-ParentProcessId', [string]$ParentProcessId,
    '-ParentStartTicks', (Quote-PathArgument $ParentStartTicks),
    '-ReadyFile', (Quote-PathArgument $ReadyFile),
    '-CancelFile', (Quote-PathArgument $CancelFile))
if ($ShowFailureDialog) { $arguments += '-ShowFailureDialog' }
# Give PowerShell an independent hidden console. A Node detached/no-window
# launch can exit without running; a shared console can die with its parent.
$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
try { Write-Output $child.Id } finally { $child.Dispose() }
