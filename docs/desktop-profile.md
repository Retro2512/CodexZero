# Desktop profile

CodexZero Desktop reuses the existing `CODEX_HOME`, or `~/.codex` when no override is set. Installation does not copy, replace, or delete this data.

The desktop launcher uses the core shipped with the compatible desktop build. It does not route Desktop through the separately built optimized CLI core. An inherited `CODEX_SQLITE_HOME` pointing to CodexZero's optimized CLI SQLite directory is removed for Desktop; unrelated explicit overrides are preserved.

## Shared state

The following paths and behavior were verified in the Windows desktop build `26.915.4065.0`. The macOS app uses the matching build `26.915.31945`.

* The core receives the existing home, retaining its account configuration, task rollouts and index, skills, and plugin configuration.
* Desktop stores its global settings in `CODEX_HOME/.codex-global-state.json`, including persisted UI settings, rather than in Chromium's profile.
* Desktop stores its application database at `CODEX_HOME/sqlite/codex.db`.
* Provider routing passes account operations and otherwise unhandled requests through to the embedded core. Thread listing includes all model providers when the caller has not specified a filter.

Chromium uses a separate `LocalAppData/CodexZero/Browser` directory. CodexZero does not copy live cookies, browser extensions, caches, or LevelDB databases. Reusing the core account does not prove that every browser session or remote connection can be restored without authentication. Those flows require integration testing with their respective services.

## Compatibility and concurrency

The source application is unchanged. Both applications can address the same home, so simultaneous desktop processes may write the same global settings and application database. The launcher does not stop the original application or introduce a new concurrency restriction. Releasing an older core against state migrated by a newer original desktop also requires compatibility verification.

`test/desktop-profile.test.mjs` checks home inheritance, preservation of explicit overrides, removal of only the optimized CLI SQLite override, and the Windows launcher environment contract. It does not authenticate external accounts or modify real user profiles.
