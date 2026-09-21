[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BuildRoot
)

$ErrorActionPreference = 'Stop'

$buildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not (Test-Path -LiteralPath $buildRoot -PathType Container)) {
    throw "BuildRoot does not exist: $buildRoot"
}

$targetPath = [System.IO.Path]::GetFullPath((Join-Path $buildRoot 'CodexZero.exe'))
$iconPath = [System.IO.Path]::GetFullPath((Join-Path $buildRoot 'assets\codexzero.ico'))
if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "CodexZero.exe does not exist: $targetPath"
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "CodexZero icon does not exist: $iconPath"
}

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class CodexZeroShortcutNative
{
    private static readonly Guid AppUserModelIdFormat = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private const uint StgReadWrite = 2;
    private const ushort VariantTypeLpWStr = 31;

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink
    {
    }

    [ComImport]
    [Guid("0000010C-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        [PreserveSig] int GetClassID(out Guid classId);
        [PreserveSig] int IsDirty();
        [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
        [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;

        public PropertyKey(Guid formatId, uint propertyId)
        {
            FormatId = formatId;
            PropertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort VariantType;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    public static void SetAppUserModelId(string fileName, string appUserModelId)
    {
        object link = new ShellLink();
        IntPtr valuePointer = IntPtr.Zero;
        try
        {
            IPersistFile persistFile = (IPersistFile)link;
            Check(persistFile.Load(fileName, StgReadWrite));
            IPropertyStore propertyStore = (IPropertyStore)link;
            PropertyKey key = new PropertyKey(AppUserModelIdFormat, 5);
            valuePointer = Marshal.StringToCoTaskMemUni(appUserModelId);
            PropVariant value = new PropVariant
            {
                VariantType = VariantTypeLpWStr,
                Pointer = valuePointer
            };
            Check(propertyStore.SetValue(ref key, ref value));
            Check(propertyStore.Commit());
            Check(persistFile.Save(fileName, true));
            Marshal.FinalReleaseComObject(propertyStore);
            Marshal.FinalReleaseComObject(persistFile);
        }
        finally
        {
            if (valuePointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(valuePointer);
            }
            Marshal.FinalReleaseComObject(link);
        }
    }

    private static void Check(int hResult)
    {
        if (hResult < 0)
        {
            Marshal.ThrowExceptionForHR(hResult);
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp

$shell = New-Object -ComObject WScript.Shell
$desktopDirectory = $shell.SpecialFolders.Item('Desktop')
$programsDirectory = $shell.SpecialFolders.Item('Programs')
$shortcutPaths = @(
    (Join-Path $desktopDirectory 'CodexZero.lnk'),
    (Join-Path $programsDirectory 'CodexZero.lnk')
)
$rootPrefix = $buildRoot.TrimEnd('\') + '\'

function Get-NormalizedShortcutTarget {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ''
    }
    try {
        return [System.IO.Path]::GetFullPath($Path.Trim().Trim('"'))
    } catch {
        return $Path.Trim().Trim('"')
    }
}

function Test-ShortcutBelongsToBuild {
    param([Parameter(Mandatory = $true)][string]$Path)

    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($Path)
        $existingTarget = Get-NormalizedShortcutTarget ([string]$shortcut.TargetPath)
    } catch {
        throw "Existing CodexZero shortcut cannot be inspected: $Path"
    } finally {
        if ($null -ne $shortcut) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
        }
    }
    if ([string]::IsNullOrWhiteSpace($existingTarget) -or
        -not $existingTarget.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    return $true
}

foreach ($shortcutPath in $shortcutPaths) {
    if (-not (Test-Path -LiteralPath $shortcutPath)) {
        continue
    }
    if ((Get-Item -LiteralPath $shortcutPath).PSIsContainer) {
        throw "Existing CodexZero shortcut path is a directory: $shortcutPath"
    }
    if (-not (Test-ShortcutBelongsToBuild $shortcutPath)) {
        throw "Existing CodexZero shortcut points to a different build: $shortcutPath"
    }
}

foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $targetPath
        $shortcut.WorkingDirectory = $buildRoot
        $shortcut.IconLocation = "$iconPath,0"
        $shortcut.Description = 'CodexZero'
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
        }
    }
    [CodexZeroShortcutNative]::SetAppUserModelId($shortcutPath, 'CodexZero.Desktop')
}

[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
Write-Output ($shortcutPaths -join [Environment]::NewLine)
