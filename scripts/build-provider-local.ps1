param([string]$OutputDirectory, [string]$DesktopBinary, [string]$DesktopPackage)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path $source ('work\local-providers\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) {
    throw "Build destination already exists. Choose a new directory."
}
$staging = $null
# Remove the extracted desktop whether or not the build succeeds.
trap {
    if ($staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    break
}
if (!$DesktopBinary) {
    # Use the pinned official desktop. It is never shipped with CodexZero.
    $staging = Join-Path ([IO.Path]::GetTempPath()) ('codexzero-desktop-' + [guid]::NewGuid().ToString('N'))
    $resolved = & (Join-Path $PSScriptRoot 'resolve-desktop.ps1') -StagingRoot $staging -DesktopPackage $DesktopPackage
    $DesktopBinary = @($resolved)[-1]
}
$DesktopBinary = (Resolve-Path -LiteralPath $DesktopBinary).Path
$node = if (Test-Path -LiteralPath (Join-Path $source 'runtime\node.exe')) {
    Join-Path $source 'runtime\node.exe'
} else { (Get-Command node.exe -ErrorAction Stop).Source }
New-Item -ItemType Directory -Path $destination | Out-Null
foreach ($folder in @('src', 'bin')) {
    Copy-Item -LiteralPath (Join-Path $source $folder) -Destination $destination -Recurse
}
foreach ($folder in @('config', 'prompts', 'dist')) {
    if (Test-Path -LiteralPath (Join-Path $source $folder)) {
        Copy-Item -LiteralPath (Join-Path $source $folder) -Destination $destination -Recurse
    }
}
Copy-Item -LiteralPath (Join-Path $source 'scripts') -Destination $destination -Recurse
New-Item -ItemType Directory -Path (Join-Path $destination 'assets'), (Join-Path $destination 'runtime') | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'assets\provider-settings.html') -Destination (Join-Path $destination 'assets')
foreach ($asset in @('native-provider-settings.mjs', 'native-cache-ui.mjs', 'model-pricing.mjs', 'native-provider-main.cjs', 'native-provider-preload.cjs', 'native-provider-identity.cjs', 'native-provider-environment.cjs', 'native-provider-updater.cjs', 'native-provider-update-release.cjs', 'codexzero.png', 'codexzero.ico')) {
    Copy-Item -LiteralPath (Join-Path $source "assets\$asset") -Destination (Join-Path $destination 'assets')
}
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $destination
Copy-Item -LiteralPath $node -Destination (Join-Path $destination 'runtime\node.exe')

$builder = @'
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [root, desktopBinary] = process.argv.slice(2);
const { prepareProviderLauncher } = await import(pathToFileURL(path.join(root, 'src/provider-launcher.mjs')));
const { buildNativeProviderApp } = await import(pathToFileURL(path.join(root, 'src/native-provider-build.mjs')));
// Bundle the installed Desktop runtime, not an inherited development override.
delete process.env.CODEX_ZERO_PROVIDER_CORE;
const { core, launcher } = await prepareProviderLauncher(desktopBinary, { home: root });
const nativeDesktop = await buildNativeProviderApp(desktopBinary, root);
await fs.writeFile(path.join(root, 'local-build.json'), JSON.stringify({
  builtAt: new Date().toISOString(), desktopBinary: nativeDesktop, installedDesktop: desktopBinary,
  nativeSettings: true,
  core: path.relative(root, core), launcher: path.relative(root, launcher)
}, null, 2));
console.log(root);
'@
$builderPath = Join-Path $destination 'build-local.mjs'
[System.IO.File]::WriteAllText($builderPath, $builder, [System.Text.UTF8Encoding]::new($false))
& (Join-Path $destination 'runtime\node.exe') $builderPath $destination $desktopBinary
if ($LASTEXITCODE -ne 0) { throw 'Local runtime build failed.' }
& (Join-Path $PSScriptRoot 'build-codexzero-launcher.ps1') -BuildRoot $destination
if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher build failed.' }
# The compiled launchers already use relative paths. Keep distribution metadata
# portable too, without embedding a maintainer's installed application location.
$manifestPath = Join-Path $destination 'local-build.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifest.desktopBinary = 'desktop\' + [IO.Path]::GetFileName($DesktopBinary)
$manifest.PSObject.Properties.Remove('installedDesktop')
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
foreach ($item in @(
    @{ Name = 'Start Codex.cmd'; Mode = 'desktop' }
)) {
    $command = "@echo off`r`ncd /d `"%~dp0`"`r`n`"%~dp0runtime\node.exe`" `"%~dp0bin\local-provider-app.mjs`" $($item.Mode)`r`nif errorlevel 1 pause`r`n"
    [System.IO.File]::WriteAllText((Join-Path $destination $item.Name), $command, [System.Text.Encoding]::ASCII)
}
$instructions = @'
CODEX CUSTOM MODELS

1. Open CodexZero.exe.
2. Open Settings, then Agent, then Custom models.
3. Add your model and API key, then save.

Keep this build folder in its current location.
Your regular Codex shortcut still starts the regular app.
No Codex login or subscription configuration is changed by this build.
'@
[System.IO.File]::WriteAllText((Join-Path $destination 'START HERE.txt'), $instructions)
if ($staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output "Local test build ready: $destination"
