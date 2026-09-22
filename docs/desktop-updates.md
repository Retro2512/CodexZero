# Desktop updates

The Windows native CodexZero build uses the existing Desktop update indicator and action. Its updater instance is replaced during archive assembly; the stock Codex installation is not modified.

## Release contract

The app checks `Retro2512/CodexZero` on startup and every 30 minutes. Only a newer published stable GitHub release is offered. Pushing commits alone does not trigger an update.

Each release must have a version matching `package.json`, `codex-zero-windows-x64.zip`, and `codex-zero-windows-x64.zip.sha256`. The existing release workflow produces these files. Include the updater scripts and assets in the first release that introduces this feature; older installations need that release installed once before they can receive updates through the icon.

## Install and restart

Clicking the native update action downloads and verifies the archive, validates its paths and version, and builds a separate native Desktop copy using the locally installed Codex runtime. The current app stays open during preparation. The prepared build goes under the stable launcher's `updates` directory.

After successful preparation, the native quit handler closes the app. A detached Windows PowerShell helper waits for that exact process to exit, atomically changes `current-build.txt`, then reopens the stable launcher. Existing shortcuts continue to work. The previous build and user data remain in place. A failed preparation keeps the current app running; a launcher start failure restores the prior pointer.

The helper never force kills the app. If shutdown takes longer than 120 seconds, it leaves the pointer unchanged and records `update-failed.txt`. A successful process start does not guarantee that the new app will complete startup; retained builds allow recovery by restoring or removing the pointer.

## Verification

Run `npm test` for release selection, verified downloads, native updater state, and Windows handoff tests. Run `scripts/build-provider-local.ps1` and `node scripts/verify-desktop-assets.mjs <build>` to verify a native build. A real published release install and restart must be tested separately before distribution. No release is published by these tests.

This integration applies to the native Windows CodexZero desktop build, not the CLI or macOS updater.
