# Desktop releases

Windows releases contain a complete desktop application. The setup executable installs per user, creates shortcuts, and opens CodexZero. `codex-zero-desktop-windows-x64.zip` is portable and also supports `scripts/install.ps1`; `-CliOnly` keeps the terminal installation available. Neither desktop path requires an existing Codex installation or Node.js.

## Build

The release workflow requires `desktop_url` and `desktop_sha256` for an official Windows x64 MSIX matching the version pinned by the native UI and core patches. The build downloads and checks the digest, extracts without installing the original application, assembles CodexZero, and compiles the setup with Inno Setup 6. A changed upstream application fails the existing patch guards rather than producing an incompatible build.

For a local build against the installed, compatible application:

```powershell
$desktop = Join-Path (Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation 'app\ChatGPT.exe'
scripts/build-desktop-release.ps1 -PackageRoot . -OutputDirectory work/desktop-package -DesktopBinary $desktop
scripts/build-desktop-setup.ps1 -PackageRoot work/desktop-package -OutputDirectory work/release
```

Release packages must include `dist/windows-x64/codex-zero-core.exe` to retain the optional CLI. The CI assembly supplies this before the desktop build. A source checkout without `dist` builds only the desktop.

Publish these six Windows assets together:

* `CodexZero-Setup-windows-x64.exe`
* `CodexZero-Setup-windows-x64.exe.sha256`
* `codex-zero-desktop-windows-x64.zip`
* `codex-zero-desktop-windows-x64.zip.sha256`
* `codex-zero-windows-x64.zip`
* `codex-zero-windows-x64.zip.sha256`

Keep the last two assets as the small CLI package. Older desktop updaters have a 1 GiB download limit and rebuild from that package. New desktop updaters select the separate complete desktop archive, with a 2 GiB compressed limit and an 8 GiB extraction limit. Reusing a core copies only `dist` and `runtime`, never an old GUI or old source files.

The PowerShell bootstrap prefers the setup executable and checks its digest before running it. The legacy archive fallback supports releases published before desktop packaging. Setup accepts `/NOLAUNCH` for unattended verification. Code signing requires a release signing certificate; none is configured in this repository.

## State and verification

Desktop shares the existing Codex home, not a copied snapshot. See [profile behavior](desktop-profile.md). Never package any developer profile, credentials, sessions, or installed plugin data. Only application files and the distribution runtime are bundled.

Before publishing, verify a clean Windows install, relocation, upgrade, uninstall, and existing account/chats/plugin/connection behavior. Test with the original app closed. Do not treat source tests as proof that external authentication sessions or a newer stock database can be used by an older packaged desktop.

The current complete desktop target is Windows x64. macOS archives retain the terminal installer; the native GUI patcher and updater are not yet portable to macOS. Do not publish those archives as a complete Mac desktop app.
