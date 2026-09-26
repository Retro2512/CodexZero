# Desktop releases

## Windows

Windows releases include `CodexZero-Setup-windows-x64.exe`. Setup installs per user, creates Desktop and Start menu shortcuts, and opens CodexZero. It needs no existing Codex installation, Node.js, or administrator rights.

Releases contain only CodexZero. The Codex desktop application is never published with them. Setup assembles it on the user's computer from the official package pinned in `scripts/desktop-upstream.json`:

1. If the original app is installed at exactly the pinned version, setup uses it and downloads nothing.
2. Otherwise setup downloads the pinned package from OpenAI's server and checks its size and SHA256. Setup shows the download on its progress bar.
3. The verified package is kept in `%LOCALAPPDATA%\CodexZero\cache\desktop` so updates do not download it again. Only the pinned version is kept.
4. `scripts/install-desktop.ps1` extracts the application, applies the CodexZero patches in a new `updates\<version>-<id>` build, then switches `current-build.txt` to it. Earlier builds are removed. A failed build leaves the current installation unchanged.

Uninstall removes the builds, the launcher, and the download cache. Codex chats, settings, and sign-in stay.

## macOS

The macOS one-line installer sets up `~/Applications/CodexZero.app` from the release package and opens it. It needs macOS 13 or later and no administrator rights. `CODEX_ZERO_INSTALL=cli` installs the terminal command instead, and older macOS versions get the terminal command.

Like Windows, the app is assembled on the Mac from the official build pinned in `scripts/desktop-upstream-macos.json`, with separate Apple silicon and Intel packages:

1. A matching `ChatGPT.app` or `Codex.app` in `/Applications` or `~/Applications` is used without a download.
2. Otherwise the pinned package is downloaded with a resumable transfer, checked, and kept in `~/Library/Caches/CodexZero/desktop` for updates.
3. `src/desktop-macos.mjs` copies the app, applies the same patches as Windows, and adds the CodexZero runtime inside the bundle.
4. The copy gets its own bundle identifier, name, icon, and Chromium profile (`~/Library/Application Support/CodexZero/Browser`). It drops the original's URL, document, and Dock tile registrations, so the original app keeps them.
5. The copy is re-signed ad hoc, because its contents change. The original app is never modified.

Updates build the new bundle in `~/Library/Caches/CodexZero/updates`. After the app quits, `scripts/complete-desktop-update-macos.sh` swaps it in and reopens it. A failed switch keeps the current app and records `update-failed.txt` in the cache folder.

Ad hoc signing identifies the app by its exact contents, so macOS may ask again for keychain and privacy permissions after an update. A Developer ID certificate and notarization would remove those prompts and allow a direct app download.

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

For macOS, take the versioned `ChatGPT-darwin-arm64-<version>.zip` and `ChatGPT-darwin-x64-<version>.zip` addresses from `appcast.xml` and `appcast-x64.xml`, and record both in `scripts/desktop-upstream-macos.json`. Use the build released with the pinned Windows version so both platforms run the same patched code.

`build-provider-local.ps1` accepts `-DesktopBinary` to build against a different local application during development.

## Release workflow

Each command package contains `release-manifest.json` with the full assembly source commit, original core build source commit, upstream Codex commit, and SHA256 hashes of its packaged files. GitHub build attestations identify the release workflow and artifact digests.

Set `CODEX_ZERO_VERSION=0.9.2` to install an exact release rather than the default `latest`. Set `CODEX_ZERO_VERIFY_ATTESTATION=1` to verify its attestation with GitHub CLI before installation. Verification must succeed before setup starts. To verify a downloaded asset yourself, run `gh attestation verify <asset> --repo Retro2512/CodexZero --signer-workflow Retro2512/CodexZero/.github/workflows/release.yml`.

The release workflow builds setup from the Windows package with Inno Setup 6.5 or later. On both Mac runners it installs the app, installs again as an upgrade, and launches it through Launch Services until it starts its custom model core. It then installs it on a clean runner, installs again as an upgrade, verifies the assembled desktop each time, and uninstalls it. Clear `publish` to build and verify without creating a release. The setup builder rejects any package that already contains an assembled desktop.

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

Complete desktop targets are Windows x64, Apple silicon Macs, and Intel Macs. Also verify sign-in, chats, and an update on a real Mac before publishing; the runners cannot answer keychain or privacy prompts.
