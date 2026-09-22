# Custom models

## Local Windows build

```powershell
.\scripts\build-provider-local.ps1
```

The build prints its folder under `work/local-providers`.

1. Open `CodexZero.exe` from the build folder.
2. Open Settings > Agent > Custom models.
3. Add Claude, Z.ai coding, or a custom model. Enter the exact model ID and API key, then save.

All configuration is inside Codex Settings. Each entry supports a name, API type,
base URL, model ID, API key, environment variable, context and output token limits,
reasoning controls, token prices, and enabled state.
Add one entry per model. Windows encrypts saved keys with DPAPI for your account.

Restart the local build after changing the provider list to refresh the model picker.
Custom entries appear alongside regular models and can be changed between turns.

Node and the provider bridge are bundled. Keep the build folder in place because
its compiled launcher uses absolute paths. The installed Codex application, login,
subscription credentials, and global configuration are not modified.
Your regular shortcut still starts the regular app.

CodexZero has its own icon and window identity and can run alongside regular Codex.
To create desktop and Start menu shortcuts for a build:

```powershell
.\scripts\install-codexzero-shortcuts.ps1 -BuildRoot 'C:\path\to\build'
```

## Run from source

```powershell
node .\bin\codex-zero.mjs desktop --providers
```

This builds and caches a separate Windows app copy with native Settings.
`providers settings` starts the same app, not a browser page.
The patch checks the installed app version and stops if the Settings layout has changed.

## Supported APIs

1. OpenAI Responses
2. OpenAI compatible Chat Completions
3. Anthropic Messages

The Claude preset uses the [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create).
The Z.ai preset uses the [Coding Plan endpoint](https://zcode.z.ai/en/docs/configuration).
Endpoints and model IDs remain editable. Other API protocols need an adapter.
This connects provider APIs; it does not import Claude Code login or subscription sessions.

Chat Completions and Anthropic requests collect the provider response before
emitting Codex response events. Text, images, function tools, custom tools, and
namespaced tools are supported. Hosted web search is disabled for custom tasks.
Unsupported payload types return an error. Custom tasks default to a 32000 token
context budget. Set a context limit for each model in Custom models settings.

## Verification

```powershell
npm test
$env:CODEX_ZERO_TEST_CORE = 'C:\path\to\codex.exe'
node --test test/provider-runtime.test.mjs
```

The optional runtime test uses an isolated temporary Codex home and a local mock
provider. It exercises a command tool round trip, changes providers in both
directions, and resumes after a bridge restart. It makes no paid model calls.
