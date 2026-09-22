[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BuildRoot,
    [string]$IconPath
)

$ErrorActionPreference = 'Stop'

function Get-CSharpStringLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    foreach ($character in $Value.ToCharArray()) {
        switch ($character) {
            '\' { [void]$builder.Append('\\') }
            '"' { [void]$builder.Append('\"') }
            "`r" { [void]$builder.Append('\r') }
            "`n" { [void]$builder.Append('\n') }
            "`t" { [void]$builder.Append('\t') }
            default { [void]$builder.Append($character) }
        }
    }
    [void]$builder.Append('"')
    $builder.ToString()
}

function Get-RelativePathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root)
    $targetFull = [System.IO.Path]::GetFullPath($Target)
    $rootPrefix = $rootFull.TrimEnd('\') + '\'
    if (-not $targetFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "desktopBinary must be inside BuildRoot."
    }

    $rootUri = [System.Uri]::new($rootPrefix)
    $targetUri = [System.Uri]::new($targetFull)
    $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($targetUri).ToString())
    $relative -replace '/', '\'
}

if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
    throw 'BuildRoot is required.'
}

$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not (Test-Path -LiteralPath $BuildRoot -PathType Container)) {
    throw "BuildRoot does not exist: $BuildRoot"
}

if ([string]::IsNullOrWhiteSpace($IconPath)) {
    $IconPath = Join-Path $BuildRoot 'assets\codexzero.ico'
} else {
    $IconPath = [System.IO.Path]::GetFullPath($IconPath)
}
if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
    throw "IconPath does not exist: $IconPath"
}

$manifestPath = Join-Path $BuildRoot 'local-build.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Build manifest does not exist: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($field in @('desktopBinary', 'core', 'launcher')) {
    if (-not ($manifest.PSObject.Properties.Name -contains $field) -or
        [string]::IsNullOrWhiteSpace([string]$manifest.$field)) {
        throw "Build manifest field is missing: $field"
    }
}

$desktopBinaryManifest = [string]$manifest.desktopBinary
if (-not [System.IO.Path]::IsPathRooted($desktopBinaryManifest)) {
    throw 'desktopBinary must be an absolute path.'
}
$desktopBinaryRelative = Get-RelativePathWithinRoot -Root $BuildRoot -Target $desktopBinaryManifest

$coreRelative = [string]$manifest.core
$launcherRelative = [string]$manifest.launcher
if ([System.IO.Path]::IsPathRooted($coreRelative) -or [System.IO.Path]::IsPathRooted($launcherRelative)) {
    throw 'core and launcher must be relative paths.'
}

$outputPath = Join-Path $BuildRoot 'CodexZero.exe'
$desktopLiteral = Get-CSharpStringLiteral $desktopBinaryRelative
$coreLiteral = Get-CSharpStringLiteral $coreRelative
$launcherLiteral = Get-CSharpStringLiteral $launcherRelative

$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("CodexZero")]
[assembly: AssemblyProduct("CodexZero")]

internal static class CodexZeroLauncher
{
    private const string DesktopRelative = __DESKTOP_RELATIVE__;
    private const string CoreRelative = __CORE_RELATIVE__;
    private const string LauncherRelative = __LAUNCHER_RELATIVE__;

    [STAThread]
    private static int Main()
    {
        try
        {
            string executablePath = Process.GetCurrentProcess().MainModule.FileName;
            string root = Path.GetDirectoryName(executablePath);
            string launchRoot = root;
            string pointer = Path.Combine(root, "current-build.txt");
            if (File.Exists(pointer))
            {
                string relative = File.ReadAllText(pointer).Trim();
                string selected = Path.GetFullPath(Path.Combine(root, relative));
                string updates = Path.GetFullPath(Path.Combine(root, "updates")) + Path.DirectorySeparatorChar;
                if (Path.IsPathRooted(relative) || !selected.StartsWith(updates, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Invalid update location.");
                string updatedLauncher = Path.Combine(selected, "CodexZero.exe");
                if (!File.Exists(updatedLauncher)) throw new FileNotFoundException("The update could not be opened.");
                ProcessStartInfo updateInfo = new ProcessStartInfo {
                    FileName = updatedLauncher, WorkingDirectory = selected, UseShellExecute = false, CreateNoWindow = true
                };
                updateInfo.EnvironmentVariables["CODEX_ZERO_LAUNCH_ROOT"] = launchRoot;
                Process.Start(updateInfo);
                return 0;
            }
            string desktopBinary = Path.GetFullPath(Path.Combine(root, DesktopRelative));
            string core = Path.GetFullPath(Path.Combine(root, CoreRelative));
            string launcher = Path.GetFullPath(Path.Combine(root, LauncherRelative));

            if (!File.Exists(desktopBinary))
            {
                throw new FileNotFoundException("The Codex desktop executable was not found.", desktopBinary);
            }

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string browserData = Path.Combine(localAppData, "CodexZero", "Browser");
            string appData = browserData;
            Directory.CreateDirectory(browserData);
            Directory.CreateDirectory(appData);

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = desktopBinary,
                Arguments = QuoteArgument("--user-data-dir=" + browserData),
                WorkingDirectory = Path.GetDirectoryName(desktopBinary),
                UseShellExecute = false,
                CreateNoWindow = false
            };
            startInfo.EnvironmentVariables["CODEX_CLI_PATH"] = launcher;
            startInfo.EnvironmentVariables["CODEX_APP_SERVER_FORCE_CLI"] = "1";
            startInfo.EnvironmentVariables["CODEX_ZERO_PROVIDER_CORE"] = core;
            startInfo.EnvironmentVariables["CODEX_ZERO_DESKTOP"] = "1";
            startInfo.EnvironmentVariables["CODEX_ZERO_LAUNCH_ROOT"] = Environment.GetEnvironmentVariable("CODEX_ZERO_LAUNCH_ROOT") ?? launchRoot;
            startInfo.EnvironmentVariables["CODEX_ELECTRON_USER_DATA_PATH"] = appData;
            // Match desktopProfileEnvironment: reuse the original Codex home,
            // including its account, task index, skills, and desktop settings.
            // Chromium keeps its separate profile; never copy its live databases.
            string codexHome = Environment.GetEnvironmentVariable("CODEX_HOME");
            if (String.IsNullOrEmpty(codexHome))
                codexHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            startInfo.EnvironmentVariables["CODEX_HOME"] = codexHome;
            string zeroHome = Environment.GetEnvironmentVariable("CODEX_ZERO_HOME");
            if (String.IsNullOrEmpty(zeroHome)) zeroHome = Path.Combine(codexHome, "codexzero");
            string optimizedSqlite = Environment.GetEnvironmentVariable("CODEX_ZERO_SQLITE_HOME");
            if (String.IsNullOrEmpty(optimizedSqlite)) optimizedSqlite = Path.Combine(zeroHome, "sqlite");
            string inheritedSqlite = Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME");
            if (!String.IsNullOrEmpty(inheritedSqlite) && String.Equals(
                Path.GetFullPath(inheritedSqlite).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                Path.GetFullPath(optimizedSqlite).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
                startInfo.EnvironmentVariables.Remove("CODEX_SQLITE_HOME");
            Process.Start(startInfo);
            return 0;
        }
        catch (Exception exception)
        {
            try
            {
                MessageBox.Show(exception.Message, "CodexZero", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch
            {
            }
            return 1;
        }
    }

    private static string QuoteArgument(string value)
    {
        StringBuilder quoted = new StringBuilder();
        int backslashes = 0;
        quoted.Append('"');
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                quoted.Append('\\', backslashes);
                backslashes = 0;
            }
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
'@
$source = $source.Replace('__DESKTOP_RELATIVE__', $desktopLiteral)
$source = $source.Replace('__CORE_RELATIVE__', $coreLiteral)
$source = $source.Replace('__LAUNCHER_RELATIVE__', $launcherLiteral)

$temporarySource = Join-Path ([System.IO.Path]::GetTempPath()) ("CodexZeroLauncher-$([guid]::NewGuid().ToString('N')).cs")
$frameworkDirectory = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$cscPath = Join-Path $frameworkDirectory 'csc.exe'
if (-not (Test-Path -LiteralPath $cscPath -PathType Leaf)) {
    throw "C# compiler does not exist: $cscPath"
}

try {
    [System.IO.File]::WriteAllText($temporarySource, $source, [System.Text.UTF8Encoding]::new($false))
    $compilerArguments = @(
        '/nologo'
        '/target:winexe'
        "/win32icon:$IconPath"
        "/out:$outputPath"
        "/reference:$(Join-Path $frameworkDirectory 'System.Windows.Forms.dll')"
        $temporarySource
    )
    & $cscPath @compilerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "C# compiler failed with exit code $LASTEXITCODE."
    }
} finally {
    Remove-Item -LiteralPath $temporarySource -Force -ErrorAction SilentlyContinue
}

Write-Output $outputPath
