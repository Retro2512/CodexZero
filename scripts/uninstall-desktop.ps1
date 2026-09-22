[CmdletBinding()]
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexZero'), [switch]$SkipShortcuts)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallRoot).Path).TrimEnd('\')
$marker = Get-Content -Raw -LiteralPath (Join-Path $root 'desktop-install.json') | ConvertFrom-Json
if ($marker.product -ne 'CodexZero.Desktop' -or $marker.installer -ne 'archive' -or [IO.Path]::GetFileName($root) -ne 'CodexZero') {
    throw 'This folder is not a CodexZero archive installation.'
}
if (Test-Path -LiteralPath (Join-Path $root 'unins000.exe')) {
    throw 'Uninstall CodexZero from Windows Settings.'
}
$prefix = $root + '\'
# Never follow a junction out of the application installation.
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid installation folder.' }
foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid installation contents.' }
    if (![IO.Path]::GetFullPath($item.FullName).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation contents.' }
}
foreach ($process in Get-CimInstance Win32_Process) {
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Close CodexZero before continuing.'
    }
}
if (!$SkipShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($location in @('Desktop', 'Programs')) {
            $shortcutPath = Join-Path $shell.SpecialFolders.Item($location) 'CodexZero.lnk'
            if (Test-Path -LiteralPath $shortcutPath) {
                $shortcut = $shell.CreateShortcut($shortcutPath)
                try {
                    if ([string]::Equals($shortcut.TargetPath, (Join-Path $root 'CodexZero.exe'), [StringComparison]::OrdinalIgnoreCase)) {
                        Remove-Item -LiteralPath $shortcutPath -Force
                    }
                } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
            }
        }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}
# Only this validated application tree is removed. Codex home and Browser stay.
Remove-Item -LiteralPath $root -Recurse -Force
Write-Output 'CodexZero uninstalled.'
