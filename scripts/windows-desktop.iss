#ifndef PackageRoot
  #error PackageRoot is required
#endif
#ifndef OutputDirectory
  #error OutputDirectory is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif

[Setup]
AppId={{DA05A763-8CD9-4718-B131-9CDB23C52BC8}
AppName=CodexZero
AppVersion={#AppVersion}
AppPublisher=CodexZero
DefaultDirName={localappdata}\Programs\CodexZero
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
UninstallDisplayName=CodexZero
UninstallDisplayIcon={app}\CodexZero.exe
SetupIconFile={#PackageRoot}\assets\codexzero.ico
OutputDir={#OutputDirectory}
OutputBaseFilename=CodexZero-Setup-windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
Uninstallable=yes

[Files]
Source: "{#PackageRoot}\*"; DestDir: "{app}"; Excludes: "current-build.txt,update-failed.txt,updates\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\CodexZero"; Filename: "{app}\CodexZero.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\codexzero.ico"
Name: "{userdesktop}\CodexZero"; Filename: "{app}\CodexZero.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\codexzero.ico"

[Run]
Filename: "{app}\CodexZero.exe"; Description: "Open CodexZero"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent; Check: CanLaunch
Filename: "{app}\CodexZero.exe"; WorkingDir: "{app}"; Flags: nowait postinstall skipifnotsilent; Check: CanLaunchSilently

[Code]
var
  InstallReady: Boolean;
  CheckingUninstall: Boolean;

function GetCurrentProcessId(): Cardinal;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

// Match the installation path, never a process name shared with original Codex.
function InstallationIsRunning(): Boolean;
var
  Locator, Services, Processes, Process: Variant;
  Index: Integer;
  CurrentPid, UninstallerParentPid: Cardinal;
  Root, Executable, CommandLine: String;
begin
  if not FileExists(ExpandConstant('{app}\CodexZero.exe')) and
     not FileExists(ExpandConstant('{app}\desktop\ChatGPT.exe')) then begin
    Result := False;
    Exit;
  end;
  Result := True;
  Root := Lowercase(AddBackslash(ExpandConstant('{app}')));
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    CurrentPid := GetCurrentProcessId();
    UninstallerParentPid := 0;
    Processes := Services.ExecQuery('SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine FROM Win32_Process');
    // Uninstall executes from a temporary copy while its original parent waits.
    if CheckingUninstall then
      for Index := 0 to Processes.Count - 1 do begin
        Process := Processes.ItemIndex(Index);
        if Process.ProcessId = CurrentPid then
          UninstallerParentPid := Process.ParentProcessId;
      end;
    for Index := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(Index);
      if Process.ProcessId = CurrentPid then Continue;
      if not VarIsNull(Process.ExecutablePath) then begin
        Executable := Lowercase(Process.ExecutablePath);
        if CheckingUninstall and (Process.ProcessId = UninstallerParentPid) then
          if CompareText(Executable, ExpandConstant('{uninstallexe}')) = 0 then Continue;
        if Pos(Root, Executable) = 1 then Exit;
      end;
      // The update helper runs in PowerShell outside the installation tree.
      if not VarIsNull(Process.CommandLine) then begin
        CommandLine := Lowercase(Process.CommandLine);
        if ((Pos('complete-desktop-update.ps1', CommandLine) > 0) or
            ((Pos('updates\.stage-', CommandLine) > 0) and
             (Pos('\complete.ps1', CommandLine) > 0))) and
           (Pos(Root, CommandLine) > 0) then Exit;
      end;
    end;
    Result := False;
  except
    // Do not replace a live installation when its process state is unknown.
    Log('Could not inspect running processes.');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if InstallationIsRunning() then
    Result := 'Close CodexZero before continuing.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    // Retain the pointer through failed installs. Only a completed replacement
    // may switch the stable launcher back to the newly installed application.
    InstallReady := True;
    if FileExists(ExpandConstant('{app}\current-build.txt')) then
      InstallReady := DeleteFile(ExpandConstant('{app}\current-build.txt'));
    if not InstallReady then
      RaiseException('Could not finish installing CodexZero. Close CodexZero and run setup again.');
  end;
end;

function CanLaunch(): Boolean;
var
  Index: Integer;
begin
  Result := InstallReady;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/NOLAUNCH') = 0 then
      Result := False;
end;

function CanLaunchSilently(): Boolean;
begin
  Result := WizardSilent and CanLaunch();
end;

function InitializeUninstall(): Boolean;
begin
  CheckingUninstall := True;
  Result := not InstallationIsRunning();
  if not Result then
    MsgBox('Close CodexZero before continuing.', mbError, MB_OK);
end;
