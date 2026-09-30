[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchRoot,

    [Parameter(Mandatory = $true)]
    [string]$BuildRoot,

    [Parameter(Mandatory = $true)]
    [int]$ParentProcessId,

    [Parameter(Mandatory = $true)]
    [string]$ParentStartTicks,

    [string]$ReadyFile,
    [string]$CancelFile,
    [switch]$ShowFailureDialog
)

$ErrorActionPreference = 'Stop'

$failureMessage = 'CodexZero update failed.'
$failurePath = $null
$pointerPath = $null
$pointerUpdated = $false
$oldPointerExists = $false
$oldPointerBytes = $null
$stableLauncherPath = $null
$resolvedLaunchRoot = $null
$launcherStartFailed = $false
$parentHasExited = $false
$launchOutcomeUnknown = $false

function Write-AtomicBytes {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $directory = [System.IO.Path]::GetDirectoryName($DestinationPath)
    $temporaryPath = Join-Path $directory ('.codexzero-update-{0}.tmp' -f [System.Guid]::NewGuid().ToString('N'))
    $backupPath = Join-Path $directory ('.codexzero-backup-{0}.tmp' -f [System.Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllBytes($temporaryPath, $Bytes)
        if ([System.IO.File]::Exists($DestinationPath)) {
            [System.IO.File]::Replace($temporaryPath, $DestinationPath, $backupPath)
        } else {
            [System.IO.File]::Move($temporaryPath, $DestinationPath)
        }
    } finally {
        if ([System.IO.File]::Exists($temporaryPath)) {
            try { [System.IO.File]::Delete($temporaryPath) } catch { }
        }
        if ([System.IO.File]::Exists($backupPath)) {
            try { [System.IO.File]::Delete($backupPath) } catch { }
        }
    }
}

function Write-AtomicText {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    Write-AtomicBytes -DestinationPath $DestinationPath -Bytes $utf8.GetBytes($Text)
}

function Restore-PreviousPointer {
    if ($oldPointerExists) {
        Write-AtomicBytes -DestinationPath $pointerPath -Bytes $oldPointerBytes
        return
    }

    if ([System.IO.File]::Exists($pointerPath)) {
        $directory = [System.IO.Path]::GetDirectoryName($pointerPath)
        $removedPath = Join-Path $directory ('.codexzero-rollback-{0}.tmp' -f [System.Guid]::NewGuid().ToString('N'))
        try {
            [System.IO.File]::Move($pointerPath, $removedPath)
        } finally {
            if ([System.IO.File]::Exists($removedPath)) {
                [System.IO.File]::Delete($removedPath)
            }
        }
    }
}

function Stop-IfCancelled {
    if ($CancelFile -and [IO.File]::Exists($CancelFile)) {
        if ($ReadyFile -and [IO.File]::Exists($ReadyFile)) { [IO.File]::Delete($ReadyFile) }
        exit 0
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($LaunchRoot)) {
        throw 'LaunchRoot is required.'
    }
    if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
        throw 'BuildRoot is required.'
    }
    if ($ParentProcessId -le 0) {
        throw 'ParentProcessId must be positive.'
    }

    $parsedParentStartTicks = 0L
    if (-not [long]::TryParse(
        $ParentStartTicks,
        [System.Globalization.NumberStyles]::None,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsedParentStartTicks
    ) -or $parsedParentStartTicks -le 0) {
        throw 'ParentStartTicks must be a positive integer.'
    }

    $resolvedLaunchRoot = (Resolve-Path -LiteralPath $LaunchRoot -ErrorAction Stop).ProviderPath
    $resolvedLaunchRoot = [System.IO.Path]::GetFullPath($resolvedLaunchRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $failurePath = Join-Path $resolvedLaunchRoot 'update-failed.txt'

    $updatesPath = Join-Path $resolvedLaunchRoot 'updates'
    $resolvedUpdatesRoot = (Resolve-Path -LiteralPath $updatesPath -ErrorAction Stop).ProviderPath
    $resolvedUpdatesRoot = [System.IO.Path]::GetFullPath($resolvedUpdatesRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $resolvedBuildRoot = (Resolve-Path -LiteralPath $BuildRoot -ErrorAction Stop).ProviderPath
    $resolvedBuildRoot = [System.IO.Path]::GetFullPath($resolvedBuildRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    $updatesPrefix = $resolvedUpdatesRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedBuildRoot.StartsWith($updatesPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'BuildRoot must be inside the updates directory.'
    }

    $newExecutablePath = Join-Path $resolvedBuildRoot 'CodexZero.exe'
    $newManifestPath = Join-Path $resolvedBuildRoot 'local-build.json'
    if (-not (Test-Path -LiteralPath $newExecutablePath -PathType Leaf)) {
        throw 'The staged CodexZero executable is missing.'
    }
    if (-not (Test-Path -LiteralPath $newManifestPath -PathType Leaf)) {
        throw 'The staged build manifest is missing.'
    }
    $null = Get-Content -Raw -LiteralPath $newManifestPath | ConvertFrom-Json -ErrorAction Stop

    $stableLauncherPath = Join-Path $resolvedLaunchRoot 'CodexZero.exe'
    if (-not (Test-Path -LiteralPath $stableLauncherPath -PathType Leaf)) {
        throw 'The stable CodexZero launcher is missing.'
    }

    # Confirm that this helper has parsed, validated the build and can run
    # independently before the application is allowed to close.
    if ($ReadyFile) {
        $readyPath = [IO.Path]::GetFullPath($ReadyFile)
        if ([IO.Path]::GetDirectoryName($readyPath) -ne [IO.Path]::GetFullPath($PSScriptRoot) -or
            -not $readyPath.StartsWith($updatesPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Invalid handoff readiness location.'
        }
        if ($CancelFile) {
            $cancelPath = [IO.Path]::GetFullPath($CancelFile)
            if ([IO.Path]::GetDirectoryName($cancelPath) -ne [IO.Path]::GetDirectoryName($readyPath)) {
                throw 'Invalid handoff cancellation location.'
            }
            Stop-IfCancelled
        }
        Write-AtomicText -DestinationPath $readyPath -Text 'ready'
    }

    $deadline = [System.DateTime]::UtcNow.AddSeconds(120)
    $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if ($null -ne $parent) {
        try {
            $runningStartTicks = $null
            try {
                $null = $parent.Handle
                $runningStartTicks = $parent.StartTime.ToUniversalTime().Ticks
            } catch {
                # Windows PowerShell can return a process whose StartTime is
                # already unavailable by the time this property is read.
                # Missing identity is safe only when that process has exited.
                if (-not $parent.HasExited) { throw }
            }
            if ($runningStartTicks -eq $parsedParentStartTicks) {
                # Hold the same process handle instead of looking up the PID
                # again on each poll. A reused PID cannot extend this wait.
                while (-not $parent.WaitForExit(250)) {
                    Stop-IfCancelled
                    if ([System.DateTime]::UtcNow -ge $deadline) {
                        throw [System.TimeoutException]::new('The parent process did not exit in time.')
                    }
                }
            }
        } finally {
            $parent.Dispose()
        }
    }
    $parentHasExited = $true
    Stop-IfCancelled

    $pointerPath = Join-Path $resolvedLaunchRoot 'current-build.txt'
    $oldPointerExists = [System.IO.File]::Exists($pointerPath)
    if ($oldPointerExists) {
        $oldPointerBytes = [System.IO.File]::ReadAllBytes($pointerPath)
    }

    $launchPrefix = $resolvedLaunchRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedBuildRoot.StartsWith($launchPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The build pointer is outside the launch directory.'
    }
    $relativeBuildPath = $resolvedBuildRoot.Substring($launchPrefix.Length)
    $relativeResolvedPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedLaunchRoot $relativeBuildPath))
    if (-not $relativeResolvedPath.StartsWith($updatesPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The build pointer is outside the updates directory.'
    }

    Write-AtomicText -DestinationPath $pointerPath -Text $relativeBuildPath
    $pointerUpdated = $true

    try {
        # The new launcher's update mode propagates early desktop startup
        # failures through the stable launcher rather than reporting a spawn
        # as a successful update. Old stable launchers exit immediately, so
        # launch the validated new launcher directly for this first start.
        $env:CODEX_ZERO_LAUNCH_ROOT = $resolvedLaunchRoot
        $env:CODEX_ZERO_UPDATE_STARTUP = '1'
        try {
            $launched = Start-Process -FilePath $newExecutablePath -WorkingDirectory $resolvedBuildRoot -WindowStyle Hidden -PassThru -ErrorAction Stop
            try {
                if (-not $launched.WaitForExit(15000)) {
                    # Do not reopen an older build alongside a launch that may
                    # still complete. Never kill the user's app on a timeout.
                    $launchOutcomeUnknown = $true
                    throw 'The updated application startup could not be confirmed.'
                }
                if ($launched.ExitCode -ne 0) {
                    throw 'The updated application did not start.'
                }
            } finally { $launched.Dispose() }
        } finally { Remove-Item Env:CODEX_ZERO_UPDATE_STARTUP -ErrorAction SilentlyContinue }
    } catch {
        $launcherStartFailed = $true
        throw 'The updated launcher could not be started.'
    }
} catch {
    # A slow launcher is not a confirmed failure. Leave it and its selected
    # build alone rather than reporting failure or opening a second instance.
    if ($launchOutcomeUnknown) { exit 1 }
    $previousPointerRestored = $false
    if ($pointerUpdated -and -not $launchOutcomeUnknown -and $null -ne $pointerPath) {
        try {
            Restore-PreviousPointer
            $pointerUpdated = $false
            $previousPointerRestored = $true
        } catch {
            # Continue so a generic failure marker can still be written.
        }
    }

    if ($null -eq $failurePath -and -not [string]::IsNullOrWhiteSpace($LaunchRoot)) {
        try {
            $candidateLaunchRoot = [System.IO.Path]::GetFullPath($LaunchRoot)
            if ([System.IO.Directory]::Exists($candidateLaunchRoot)) {
                $failurePath = Join-Path $candidateLaunchRoot 'update-failed.txt'
            }
        } catch {
            $failurePath = $null
        }
    }

    if ($null -ne $failurePath) {
        try {
            $utf8 = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($failurePath, $failureMessage, $utf8)
        } catch {
            # There is no safe secondary location for the failure marker.
        }
    }
    # This dialog belongs to the independent helper, not the exiting app.
    # Older versions do not yet consume update-failed.txt on startup.
    # Acknowledge it before reopening to avoid duplicate startup dialogs.
    if ($ShowFailureDialog -and $parentHasExited) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show('Could not update CodexZero. Try again.', 'CodexZero', 'OK', 'Error')
            if ($null -ne $failurePath -and [IO.File]::Exists($failurePath)) {
                [IO.File]::Delete($failurePath)
            }
        } catch { }
    }
    # Persist before reopening: startup must not race the failure marker.
    $canReopenPrevious = $parentHasExited -and (-not $pointerUpdated) -and
        (($launcherStartFailed -and $previousPointerRestored) -or (-not $launcherStartFailed))
    if ($canReopenPrevious -and $null -ne $stableLauncherPath) {
        try {
            Start-Process -FilePath $stableLauncherPath -WorkingDirectory $resolvedLaunchRoot -WindowStyle Hidden -ErrorAction Stop
        } catch { }
    }
    exit 1
}
