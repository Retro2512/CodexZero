# Desktop releases

Windows releases include `CodexZero-Setup-windows-x64.exe`. Setup installs per user, creates Desktop and Start menu shortcuts, and opens CodexZero. It needs no existing Codex installation, Node.js, or administrator rights.

Releases contain only CodexZero. The Codex desktop application is never published with them. Setup assembles it on the user's computer from the official package pinned in `scripts/desktop-upstream.json`:

1. If the original app is installed at exactly the pinned version, setup uses it and downloads nothing.
2. Otherwise setup downloads the pinned package from OpenAI's server and checks its size and SHA256. Setup shows the download on its progress bar.
3. The verified package is kept in `%LOCALAPPDATA%\CodexZero\cache\desktop` so updates do not download it again. Only the pinned version is kept.
4. `scripts/install-desktop.ps1` extracts the application, applies the CodexZero patches in a new `updates\<version>-<id>` build, then switches `current-build.txt` to it. Earlier builds are removed. A failed build leaves the current installation unchanged.

Uninstall removes the builds, the launcher, and the download cache. Codex chats, settings, and sign-in stay.

## Changing the pinned desktop

The native patches fail closed on an unexpected application. Pin a new build only after the patches are verified against it:

1. Download `https://persistent.oaistatic.com/codex-app-prod/releases/<version>/ChatGPT-x64.msix`. Do not use the unversioned `ChatGPT-x64.msix` address, because its contents change with each release.
2. Record its version, SHA256, and size in `scripts/desktop-upstream.json`.
3. Build and verify it locally:

```powershell
scripts/build-provider-local.ps1 -OutputDirectory work/desktop-check
node scripts/verify-complete-desktop.mjs work/desktop-check
```

4. Update the verified build in [desktop profile](desktop-profile.md).

`build-provider-local.ps1` accepts `-DesktopBinary` to build against a different local application during development.

## Release workflow

The release workflow builds setup from the Windows package with Inno Setup 6.5 or later. It then installs it on a clean runner, installs again as an upgrade, verifies the assembled desktop each time, and uninstalls it. Clear `publish` to build and verify without creating a release. The setup builder rejects any package that already contains an assembled desktop.

Publish these Windows assets together:

* `CodexZero-Setup-windows-x64.exe`
* `CodexZero-Setup-windows-x64.exe.sha256`
* `codex-zero-windows-x64.zip`
* `codex-zero-windows-x64.zip.sha256`

The ZIP package is the CLI installation and the update package. Desktop updates rebuild from it with the same pinned application. Run `scripts/install.ps1 -Desktop` from the extracted ZIP to install the desktop without setup, or `-CliOnly` for the terminal installation.

The PowerShell bootstrap prefers setup and checks its digest before running it. Code signing requires a release signing certificate; none is configured in this repository.

## State and verification

Desktop shares the existing Codex home, not a copied snapshot. See [profile behavior](desktop-profile.md). Never package any developer profile, credentials, sessions, or installed plugin data.

Before publishing, verify a clean Windows install, upgrade, update, and uninstall, and existing account, chat, plugin, and connection behavior. Test with the original app closed. Do not treat source tests as proof that external authentication sessions or a newer stock database can be used by an older packaged desktop.

The current complete desktop target is Windows x64. macOS archives retain the terminal installer; the native GUI patcher and updater are not yet portable to macOS.
